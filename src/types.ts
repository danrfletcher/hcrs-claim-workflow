import { z } from 'zod';

export const ExtractedFieldsSchema = z.object({
  provider_name: z.string().nullable(),
  policy_reference: z.string().nullable(),
  cover_start_date: z.string().nullable(), // ISO date string YYYY-MM-DD
  cancelled_date: z.string().nullable(),
  total_premiums_paid: z.number().nullable(),
  commission_amount: z.number().nullable(),
  commission_basis: z.enum(['discretionary', 'fixed', 'none']).nullable(),
  discretion_exercised: z.boolean().nullable(),
  prior_ruling: z.enum(['none', 'ombudsman', 'court', 'settled']).nullable(),
});

export type ExtractedFields = z.infer<typeof ExtractedFieldsSchema>;

export type Verdict = 'ELIGIBLE' | 'NOT_ELIGIBLE' | 'INSUFFICIENT_DATA' | 'ESCALATE_HUMAN' | 'FAILED';

export interface Decision {
  verdict: Verdict;
  reasonCode: string;
  reasonText: string;
  drivingField?: string;
}

export interface UsageStats {
  promptTokens: number;
  completionTokens: number;
  costGbp: number;
}

export interface Trace {
  runId: string;
  docId: string;
  timestamp: string;
  model: string;
  usage: UsageStats;
  extractedFields: ExtractedFields | null;
  decision: Decision;
}