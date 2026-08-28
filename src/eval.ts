import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { processDocument, extractWithModel } from './pipeline.js';
import { evaluateEligibility } from './rules.js';
import type { ExtractedFields, Decision } from './types.js';

interface GroundTruthSpec {
  doc_id: string;
  expected_verdict: string;
  expected_reason_code: string;
  fields: ExtractedFields;
}

async function runEvaluation() {
  console.log('🚀 Starting HCRS-1 Evaluation Pipeline...\n');

  // 1. Load Ground Truth Specs
  const specsPath = path.resolve('./data/specs.json');
  if (!fs.existsSync(specsPath)) {
    console.error('❌ Missing ./data/specs.json file!');
    process.exit(1);
  }
  const rawSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf-8'));
  const specs: GroundTruthSpec[] = rawSpecs.documents;

  const inboxDir = path.resolve('./data/inbox');
  const files = fs.readdirSync(inboxDir).filter(f => f.endsWith('.txt'));

  let passACorrect = 0;
  let passBCorrect = 0; // Dual pass / reconciled
  let totalCostGbp = 0;

  console.log(`Processing ${files.length} test documents across 2 configurations...\n`);

  for (const file of files) {
    const docId = file.replace('.txt', '');
    const spec = specs.find(s => s.doc_id === docId);
    const filePath = path.join(inboxDir, file);

    // Config A: Primary Model (Qwen 2.5 72B)
    const traceA = await processDocument(filePath, 'qwen/qwen-2.5-72b-instruct', 'eval_run');
    totalCostGbp += traceA.usage.costGbp;

    // Config B: Secondary Model (GLM-4 9B) for Dual-Pass Reconciliation
    const rawText = fs.readFileSync(filePath, 'utf-8');
    let decisionB: Decision;
    try {
      const passBExt = await extractWithModel(rawText, 'thudm/glm-4-9b-chat');
      totalCostGbp += passBExt.usage.costGbp;
      decisionB = evaluateEligibility(passBExt.fields);
    } catch {
      decisionB = { verdict: 'FAILED', reasonCode: 'EXTRACTION_ERROR', reasonText: 'Model B failed' };
    }

    // Dual-Pass Logic: Escalate if Model A and Model B disagree
    let finalVerdictB = traceA.decision.verdict;
    if (traceA.decision.verdict !== decisionB.verdict) {
      finalVerdictB = 'ESCALATE_HUMAN';
    }

    const expected = spec ? spec.expected_verdict : 'UNKNOWN';

    const matchA = traceA.decision.verdict === expected;
    const matchB = finalVerdictB === expected;

    if (matchA) passACorrect++;
    if (matchB) passBCorrect++;

    console.log(`[${docId}] Expected: ${expected.padEnd(17)} | Pass A: ${traceA.decision.verdict.padEnd(17)} (${matchA ? '✅' : '❌'}) | Dual-Pass: ${finalVerdictB.padEnd(17)} (${matchB ? '✅' : '❌'})`);
  }

  // Cost & Performance Summary
  const avgCostPerItem = totalCostGbp / files.length;
  const projected10kCost = avgCostPerItem * 10000;

  console.log('\n================ EVALUATION SUMMARY ================');
  console.log(`Total Documents Tested:   ${files.length}`);
  console.log(`Pass A (Single Model):    ${passACorrect}/${files.length} Accuracy (${((passACorrect / files.length) * 100).toFixed(1)}%)`);
  console.log(`Pass B (Dual Reconciled): ${passBCorrect}/${files.length} Accuracy (${((passBCorrect / files.length) * 100).toFixed(1)}%)`);
  console.log('----------------------------------------------------');
  console.log(`Measured Run Cost:        £${totalCostGbp.toFixed(4)}`);
  console.log(`Average Cost per Item:    £${avgCostPerItem.toFixed(5)}`);
  console.log(`Projected 10k/Month Cost: £${projected10kCost.toFixed(2)}`);
  console.log('====================================================\n');
}

runEvaluation().catch(err => {
  console.error('Fatal evaluation error:', err);
});