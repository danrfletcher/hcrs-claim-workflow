import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { processDocument, PRIMARY_MODEL, SECONDARY_MODEL } from './pipeline.js';

// Production entrypoint. One command from cold: ingest every document in data/inbox,
// run the dual-pass pipeline, write a trace per document, print a run summary.
async function main() {
  const inboxDir = path.resolve('./data/inbox');
  if (!fs.existsSync(inboxDir)) {
    console.error(`❌ No inbox directory at ${inboxDir}`);
    process.exit(1);
  }
  const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith('.txt')).sort();
  if (files.length === 0) {
    console.error('❌ No .txt documents found in data/inbox');
    process.exit(1);
  }

  console.log('HCRS-1 pipeline — ingest → extract (×2 models) → reconcile → decide → persist');
  console.log(`Primary:   ${PRIMARY_MODEL}`);
  console.log(`Secondary: ${SECONDARY_MODEL}`);
  console.log(`Processing ${files.length} document(s) from ./data/inbox ...\n`);

  const runId = `run_${Date.now()}`;
  let totalCostUsd = 0;
  const counts: Record<string, number> = {};

  for (const file of files) {
    const filePath = path.join(inboxDir, file);
    const trace = await processDocument(filePath, PRIMARY_MODEL, SECONDARY_MODEL, runId);
    totalCostUsd += trace.totalCostUsd;
    counts[trace.decision.verdict] = (counts[trace.decision.verdict] ?? 0) + 1;
    console.log(`[${trace.docId}] → ${trace.decision.verdict.padEnd(17)} (${trace.decision.reasonCode}) — $${trace.totalCostUsd.toFixed(5)}`);
  }

  console.log('\n================ RUN SUMMARY ================');
  for (const [verdict, count] of Object.entries(counts)) {
    console.log(`${verdict.padEnd(18)} ${count}`);
  }
  console.log('-----------------------------------------------');
  console.log(`Total cost:        $${totalCostUsd.toFixed(4)}`);
  console.log(`Avg cost / item:   $${(totalCostUsd / files.length).toFixed(5)}`);
  console.log(`Projected 10k/mo:  $${((totalCostUsd / files.length) * 10000).toFixed(2)}`);
  console.log(`Traces written to ./traces/  (run id: ${runId})`);
  console.log('===============================================\n');
}

main().catch((err) => {
  console.error('Fatal pipeline error:', err);
  process.exit(1);
});
