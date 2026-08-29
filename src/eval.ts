import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { processDocument, PRIMARY_MODEL, SECONDARY_MODEL } from './pipeline.js';
import type { ExtractedFields, Verdict } from './types.js';

interface GroundTruthSpec {
  doc_id: string;
  kind: string;
  expected_verdict: string;
  expected_reason_code: string;
  fields: ExtractedFields;
}

// data/inbox files are named hcrs-01.txt..hcrs-20.txt; specs.json doc_id is
// hcrs-0001..hcrs-0020. Match on the trailing number rather than the string, so
// numbering-format drift between the corpus and the spec file can't silently produce
// zero matches (as it previously did — every row fell back to 'UNKNOWN').
function trailingNumber(id: string): number {
  const match = id.match(/(\d+)(?!.*\d)/);
  const digits = match?.[1];
  return digits ? parseInt(digits, 10) : NaN;
}

/**
 * Outcome classes. The point of grading in classes rather than as a single
 * correct/incorrect bit is that "escalated to a human" is a TRADE, not an error —
 * it costs handler time and buys back a wrong answer. A single accuracy figure
 * cannot represent that, and worse, it makes the dual-pass config incapable of
 * winning: reconciliation never invents a better verdict, it only ever converts a
 * committed verdict into ESCALATE_HUMAN, which never matches a gold label.
 */
type Outcome =
  | 'correct'    // auto-decided, matches gold
  | 'harmful'    // auto-decided, and wrong in the direction that costs money
  | 'soft'       // auto-decided, wrong, but self-correcting (an INSUFFICIENT_DATA mismatch)
  | 'escalated'  // routed to a human — not an error
  | 'failed';    // extraction broke — also needs a human, but for a different reason

const ACTIONED: ReadonlySet<string> = new Set(['ELIGIBLE', 'NOT_ELIGIBLE']);

function classify(verdict: Verdict, gold: string): Outcome {
  if (verdict === 'ESCALATE_HUMAN') return 'escalated';
  if (verdict === 'FAILED') return 'failed';
  if (verdict === gold) return 'correct';
  // Harmful = a confident verdict that gets ACTED ON in the wrong direction:
  // a claim wrongly pursued, or a valid claim wrongly closed. An INSUFFICIENT_DATA
  // mismatch just sends someone to chase more paper — recoverable, so graded softer.
  if (ACTIONED.has(verdict) && ACTIONED.has(gold)) return 'harmful';
  return 'soft';
}

interface Tally {
  correct: number;
  harmful: number;
  soft: number;
  escalated: number;
  failed: number;
  costUsd: number;
}

const emptyTally = (): Tally => ({ correct: 0, harmful: 0, soft: 0, escalated: 0, failed: 0, costUsd: 0 });

function autoDecided(t: Tally): number {
  return t.correct + t.harmful + t.soft;
}

function pct(n: number, d: number): string {
  return d === 0 ? '  n/a' : `${((n / d) * 100).toFixed(1).padStart(5)}%`;
}

async function runEvaluation() {
  const specsPath = path.resolve('./data/specs.json');
  if (!fs.existsSync(specsPath)) {
    console.error('❌ Missing ./data/specs.json');
    process.exit(1);
  }
  const rawSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf-8'));
  const specs: GroundTruthSpec[] = rawSpecs.documents;
  const specsByNumber = new Map(specs.map((s) => [trailingNumber(s.doc_id), s]));

  const inboxDir = path.resolve('./data/inbox');
  const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.txt')).sort();

  console.log('HCRS-1 evaluation — paired ablation over the gold set\n');
  console.log(`Config A (single-pass):          ${PRIMARY_MODEL} alone`);
  console.log(`Config B (dual-pass reconciled): ${PRIMARY_MODEL} + ${SECONDARY_MODEL}, escalate on disagreement`);
  console.log(`\nBoth configs are scored from the SAME extraction pair per document, so the only`);
  console.log(`variable between them is the reconciliation step — not extraction noise.\n`);

  const A = emptyTally();
  const B = emptyTally();

  // Paired analysis: the only documents where the two configs can differ are those
  // where B escalated and A committed. Was that escalation worth paying for?
  let rescued = 0;   // A was wrong — escalating prevented a bad answer
  let wasteful = 0;  // A was right — escalating cost a handler for nothing

  const rows: string[] = [];
  const runId = `eval_${Date.now()}`;

  // Documents are independent, and each one spends nearly all its wall-clock waiting on the
  // two model calls. A small concurrency window overlaps that waiting without approaching a
  // rate limit — 4 documents in flight is 8 concurrent requests at most.
  const CONCURRENCY = 4;
  const scored = files
    .map((file) => ({ file, docId: file.replace('.txt', '') }))
    .map((x) => ({ ...x, spec: specsByNumber.get(trailingNumber(x.docId)) }))
    .filter((x) => {
      if (!x.spec) console.warn(`⚠️  No gold-set match for ${x.docId} — skipped`);
      return Boolean(x.spec);
    });

  for (let i = 0; i < scored.length; i += CONCURRENCY) {
    const batch = scored.slice(i, i + CONCURRENCY);
    const traces = await Promise.all(
      batch.map((x) => processDocument(path.join(inboxDir, x.file), PRIMARY_MODEL, SECONDARY_MODEL, runId))
    );

    for (let j = 0; j < batch.length; j++) {
      const entry = batch[j]!;
      const trace = traces[j]!;
      const gold = entry.spec!.expected_verdict;

      // ONE call per model per document. Config A is the primary pass's own decision;
      // Config B is the reconciled verdict over the same two passes.
      const verdictA = trace.primary.decision.verdict;
      const verdictB = trace.decision.verdict;

      const outA = classify(verdictA, gold);
      const outB = classify(verdictB, gold);

      A[outA]++;
      B[outB]++;
      A.costUsd += trace.primary.usage.costUsd;
      B.costUsd += trace.totalCostUsd;

      if (outB === 'escalated' && outA !== 'escalated') {
        if (outA === 'correct') wasteful++;
        else rescued++;
      }

      const flag = outA === outB ? ' ' : outA === 'correct' ? '·' : '✔';
      rows.push(
        `${flag} ${entry.docId.padEnd(9)} ${entry.spec!.kind.padEnd(14)} gold=${gold.padEnd(18)} A=${verdictA.padEnd(18)}${outA.padEnd(10)} B=${verdictB.padEnd(18)}${outB}`
      );
      console.log(rows[rows.length - 1]);
    }
  }

  const n = A.correct + A.harmful + A.soft + A.escalated + A.failed;

  console.log(`\n  legend: ✔ = dual-pass escalated a document single-pass got WRONG (escalation earned its cost)`);
  console.log(`          · = dual-pass escalated a document single-pass got RIGHT (escalation was waste)\n`);

  const table = [
    '| metric | A: single-pass | B: dual-pass | what it means |',
    '|---|---|---|---|',
    `| **Harmful errors** | ${A.harmful}/${n} (${pct(A.harmful, n).trim()}) | ${B.harmful}/${n} (${pct(B.harmful, n).trim()}) | Auto-decided ELIGIBLE↔NOT_ELIGIBLE the wrong way. A claim wrongly pursued or wrongly closed. **Lower is better — this is the number that costs money.** |`,
    `| Soft errors | ${A.soft}/${n} (${pct(A.soft, n).trim()}) | ${B.soft}/${n} (${pct(B.soft, n).trim()}) | Auto-decided wrong, but recoverable — sends someone to chase more paper. |`,
    `| **Automation rate** | ${autoDecided(A)}/${n} (${pct(autoDecided(A), n).trim()}) | ${autoDecided(B)}/${n} (${pct(autoDecided(B), n).trim()}) | Share auto-decided at all. **Higher is better — this is what escalation costs you.** |`,
    `| Escalated to human | ${A.escalated}/${n} | ${B.escalated}/${n} | Routed to a person. Not an error — a trade. |`,
    `| Extraction failures | ${A.failed}/${n} | ${B.failed}/${n} | Both passes broke. |`,
    `| Precision when committing | ${pct(A.correct, autoDecided(A)).trim()} | ${pct(B.correct, autoDecided(B)).trim()} | Of the documents it *did* decide, how often it was right. |`,
    `| Cost / 20 docs | $${A.costUsd.toFixed(4)} | $${B.costUsd.toFixed(4)} | Measured, not estimated. |`,
    `| Cost / item | $${(A.costUsd / n).toFixed(5)} | $${(B.costUsd / n).toFixed(5)} | |`,
    `| **Projected 10k/month** | **$${((A.costUsd / n) * 10000).toFixed(2)}** | **$${((B.costUsd / n) * 10000).toFixed(2)}** | Extraction step only — see DECISION_LOG.md Q3. |`,
  ].join('\n');

  console.log(table.replace(/\*\*/g, ''));

  console.log(`\nPaired analysis — the ${rescued + wasteful} document(s) where the configs diverged:`);
  console.log(`  ${rescued} escalation(s) caught a verdict single-pass got WRONG.`);
  console.log(`  ${wasteful} escalation(s) were waste — single-pass had it right.`);

  const harmfulAvoided = A.harmful - B.harmful;
  const extraEscalations = B.escalated - A.escalated;
  console.log(`\nThe trade: dual-pass avoided ${harmfulAvoided} harmful error(s) at the cost of`);
  console.log(`${extraEscalations} extra escalation(s) and $${(B.costUsd - A.costUsd).toFixed(4)} of additional inference.`);

  // Committed as the submission's "comparison result".
  const md = `# Evaluation result

Run: ${new Date().toISOString()} · gold set: ${n} documents · traces in \`./traces/\`

Both configurations are scored from the **same extraction pair per document**, so the only
variable between them is the reconciliation step, not extraction noise. This is a paired
ablation over n=${n}, not a randomised A/B test — directional evidence about a mechanism, not a
powered statistical claim.

## Why two numbers and not an accuracy score

Reconciliation never invents a better verdict. When both models agree, the answer *is* the
primary model's answer; the only thing dual-pass ever changes is converting a committed verdict
into an escalation. Under a single \`verdict == gold\` accuracy score every escalation counts as a
miss, so dual-pass is arithmetically incapable of winning — the metric would be measuring
willingness to guess, not correctness. Scored properly, escalation is a **trade**: it costs
handler minutes and buys back a wrong answer. So the comparison reports what the trade cost and
what it bought.

${table}

## The trade

- **${rescued}** escalation(s) caught a verdict single-pass got wrong.
- **${wasteful}** escalation(s) were waste — single-pass already had it right.
- Net: **${harmfulAvoided} harmful error(s) avoided** for **${extraEscalations} extra escalation(s)** and **$${(B.costUsd - A.costUsd).toFixed(4)}** more inference across ${n} documents.

## Which one won

See \`DECISION_LOG.md\` Q4 for the exchange rate this is judged under and the resulting call.
`;
  fs.writeFileSync('EVAL_RESULTS.md', md);
  console.log(`\nWritten: EVAL_RESULTS.md · traces: ./traces/ (run ${runId})\n`);
}

runEvaluation().catch((err) => {
  console.error('Fatal evaluation error:', err);
  process.exit(1);
});
