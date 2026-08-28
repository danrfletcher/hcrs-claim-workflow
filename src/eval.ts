import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { processDocument, extractWithModel, PRIMARY_MODEL, SECONDARY_MODEL } from './pipeline.js';
import { evaluateEligibility } from './rules.js';
import type { ExtractedFields } from './types.js';

interface GroundTruthSpec {
  doc_id: string;
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

async function runEvaluation() {
  console.log('🚀 Starting HCRS-1 Evaluation Pipeline...\n');

  const specsPath = path.resolve('./data/specs.json');
  if (!fs.existsSync(specsPath)) {
    console.error('❌ Missing ./data/specs.json file!');
    process.exit(1);
  }
  const rawSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf-8'));
  const specs: GroundTruthSpec[] = rawSpecs.documents;
  const specsByNumber = new Map(specs.map((s) => [trailingNumber(s.doc_id), s]));

  const inboxDir = path.resolve('./data/inbox');
  const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.txt')).sort();

  let configACorrect = 0;
  let configBCorrect = 0;
  let configACostUsd = 0;
  let configBCostUsd = 0;
  let unmatched = 0;

  console.log(`Processing ${files.length} test documents across 2 configurations...`);
  console.log(`Config A = single-pass (${PRIMARY_MODEL} only)`);
  console.log(`Config B = production pipeline: dual-pass reconciled (${PRIMARY_MODEL} + ${SECONDARY_MODEL}, escalate on disagreement)\n`);

  for (const file of files) {
    const docId = file.replace('.txt', '');
    const spec = specsByNumber.get(trailingNumber(docId));
    const expected = spec ? spec.expected_verdict : 'UNKNOWN';
    if (!spec) {
      unmatched++;
      console.warn(`⚠️  No gold-set match for ${docId}`);
    }

    const filePath = path.join(inboxDir, file);
    const rawText = fs.readFileSync(filePath, 'utf-8');

    // Config A: single-pass baseline. Not persisted as a trace — comparison-only, so
    // running the eval doesn't create trace files that look like real production runs.
    let verdictA = 'FAILED';
    try {
      const { fields, usage } = await extractWithModel(rawText, PRIMARY_MODEL);
      verdictA = evaluateEligibility(fields).verdict;
      configACostUsd += usage.costUsd;
    } catch {
      verdictA = 'FAILED';
    }

    // Config B: the actual production pipeline (dual-pass, reconciled, traced).
    const traceB = await processDocument(filePath, PRIMARY_MODEL, SECONDARY_MODEL, 'eval_run');
    configBCostUsd += traceB.totalCostUsd;
    const verdictB = traceB.decision.verdict;

    const matchA = verdictA === expected;
    const matchB = verdictB === expected;
    if (matchA) configACorrect++;
    if (matchB) configBCorrect++;

    console.log(`[${docId}] Expected: ${expected.padEnd(17)} | Config A: ${verdictA.padEnd(17)} (${matchA ? '✅' : '❌'}) | Config B: ${verdictB.padEnd(17)} (${matchB ? '✅' : '❌'})`);
  }

  const n = files.length;
  console.log('\n================ EVALUATION SUMMARY ================');
  console.log(`Total Documents Tested:          ${n}${unmatched ? `  (⚠️  ${unmatched} unmatched against gold set)` : ''}`);
  console.log(`Config A (single-pass):          ${configACorrect}/${n} accuracy (${((configACorrect / n) * 100).toFixed(1)}%)`);
  console.log(`Config B (dual-pass reconciled): ${configBCorrect}/${n} accuracy (${((configBCorrect / n) * 100).toFixed(1)}%)`);
  console.log('------------------------------------------------------');
  console.log(`Config A cost:   $${configACostUsd.toFixed(4)} total  |  $${(configACostUsd / n).toFixed(5)}/item  |  $${((configACostUsd / n) * 10000).toFixed(2)} projected / 10k items`);
  console.log(`Config B cost:   $${configBCostUsd.toFixed(4)} total  |  $${(configBCostUsd / n).toFixed(5)}/item  |  $${((configBCostUsd / n) * 10000).toFixed(2)} projected / 10k items`);
  console.log('========================================================\n');
}

runEvaluation().catch((err) => {
  console.error('Fatal evaluation error:', err);
  process.exit(1);
});
