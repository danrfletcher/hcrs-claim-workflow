import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { ExtractedFieldsSchema, type Decision, type ExtractedFields, type Trace, type UsageStats } from './types.js';
import { evaluateEligibility } from './rules.js';

// Initialize OpenAI client pointing to OpenRouter
const openai = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY || 'mock-key',
});

// Cost map per 1M tokens (GBP estimate for OpenRouter models)
const PRICING_MAP: Record<string, { prompt: number; completion: number }> = {
  'qwen/qwen-2.5-72b-instruct': { prompt: 0.0003, completion: 0.0004 },
  'thudm/glm-4-9b-chat': { prompt: 0.0001, completion: 0.0001 },
};

export async function extractWithModel(text: string, model: string): Promise<{ fields: ExtractedFields; usage: UsageStats }> {
  const prompt = `You are a legal data extraction agent for the Household Cover Redress Scheme (HCRS-1).
Extract the following facts from the policy document. Return NULL for any field not explicitly stated or verifiable.

Required Fields:
- provider_name (string or null)
- policy_reference (string or null)
- cover_start_date (YYYY-MM-DD or null)
- cancelled_date (YYYY-MM-DD or null)
- total_premiums_paid (number or null)
- commission_amount (number or null)
- commission_basis ("discretionary" | "fixed" | "none" | null)
- discretion_exercised (boolean or null)
- prior_ruling ("none" | "ombudsman" | "court" | "settled" | null)

DOCUMENT TEXT:
${text}`;

  const response = await openai.chat.completions.create({
    model: model,
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
    temperature: 0,
  });

  const rawContent = response.choices[0]?.message?.content || '{}';
  const jsonParsed = JSON.parse(rawContent);
  const validatedFields = ExtractedFieldsSchema.parse(jsonParsed);

  // Compute token usage & cost
  const promptTokens = response.usage?.prompt_tokens || 0;
  const completionTokens = response.usage?.completion_tokens || 0;
  
  const rates = PRICING_MAP[model] || { prompt: 0.0002, completion: 0.0002 };
  const costGbp = (promptTokens * rates.prompt + completionTokens * rates.completion) / 1000;

  return {
    fields: validatedFields,
    usage: { promptTokens, completionTokens, costGbp }
  };
}

export async function processDocument(
  filePath: string,
  model: string = 'qwen/qwen-2.5-72b-instruct',
  runId: string = `run_${Date.now()}`
): Promise<Trace> {
  const docId = path.basename(filePath);

  // 1. INGEST
  const rawText = fs.readFileSync(filePath, 'utf-8');

  // 2. EXTRACT & VALIDATE
  let fields: ExtractedFields | null = null;
  let usage: UsageStats = { promptTokens: 0, completionTokens: 0, costGbp: 0 };
  let decision: Decision;

  try {
    const extraction = await extractWithModel(rawText, model);
    fields = extraction.fields;
    usage = extraction.usage;
    
    // 3. DECIDE (Pure TS Function — rawText is discarded, injection protected)
    decision = evaluateEligibility(fields);
  } catch (err: any) {
    decision = {
      verdict: 'FAILED',
      reasonCode: 'EXTRACTION_ERROR',
      reasonText: err.message || 'Failed to extract or validate schema'
    };
  }

  // 4. PERSIST TRACE
  const trace: Trace = {
    runId,
    docId,
    timestamp: new Date().toISOString(),
    model,
    usage,
    extractedFields: fields,
    decision
  };

  const traceDir = './traces';
  if (!fs.existsSync(traceDir)) {
    fs.mkdirSync(traceDir, { recursive: true });
  }
  fs.writeFileSync(path.join(traceDir, `${docId}.json`), JSON.stringify(trace, null, 2));

  return trace;
}