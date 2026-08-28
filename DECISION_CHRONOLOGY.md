## Planning Phase
**D-01 — Problem Selection:** Picked Problem #4 (Policy agreement extraction + eligibility). Reuses a knownClaims-Eligibility mental model to save upfront domain design time.
**D-02 — Architecture:** Pure TypeScript script loop (`ingest → extract → evaluate → persist`). Dropped agent frameworks (n8n/LangGraph), SQLite queue locks, and background workers to keep execution strictly under 4 hours.
**D-03 — Model Access:** Single OpenAI SDK client pointed to OpenRouter. Evaluated dual-model pass (`Qwen 3.8 27B vs `GLM-4.7 Flash`) to compare extraction accuracy vs cost.
**D-04 — Input & Ingestion:** Local synchronous folder reader (`fs.readdirSync`) parsing 20 synthetic `.txt` policy packs. Excluded PDF/OCR to keep focus on graded evaluation and guardrails.
**D-05 — Logic & Guardrails:** Pure JS function for the eligibility rules engine (HCRS-1). Extraction output is forced through a Zod schema; original document context is purged from memory prior to evaluation so instruction injections cannot hijack decision logic.
**D-06 — Tracing & Persistence:** Saves structured JSON run traces directly to `./traces/`. Hardcoded OpenRouter token costs to compute per-item cost and 10k/month projection.

.
├── src/
│   ├── pipeline.ts   # The core 100-line loop: reads file, calls OpenRouter, runs rules, writes trace
│   ├── rules.ts      # Pure JS function: evaluates extracted fields against HCRS-1 criteria
│   ├── eval.ts       # Evaluates the 20 gold-set files (Config A vs Config B) & prints cost table
│   └── types.ts      # Zod schema & TypeScript interfaces
├── data/inbox/       # 20 synthetic .txt files
└── DECISION_LOG.md   # Written answers to the 7 questions

## Synthetic Data Generation
**D-07 — Synthetic Data Pipeline:** Authored ground-truth specifications (`specs.json`) directly in code to establish deterministic `gold.json` targets. Generated 20 realistic `.txt` policy packs via one-shot calls to Gemini 3.6 Flash using a seed of 42. Bypassed multi-agent validation loops to keep generation under 15 minutes, relying on `eval.ts` to surface extraction mismatches empirically.

## Initial Workflow Scaffold
**D-08 — Schema & Type Contract:** Defined the nine HCRS-1 fields as a nullable Zod schema (`ExtractedFieldsSchema`) plus `Decision`/`Trace`/`UsageStats` interfaces in `types.ts` — one contract shared by extraction, rules and tracing, so a field can't silently drift shape between stages.
**D-09 — Eligibility Ruleset as a Pure Function:** Implemented the gate cascade (A window → C4 early cancellation → C3 prior ruling → C2 no commission → C1 de minimis → B1 discretion / B2 ratio) as a single deterministic function in `rules.ts` that only ever sees validated fields, never raw document text — the injection-resistance from D-05 realised in code, not just stated.
**D-10 — Single-Pass Extraction Pipeline:** `pipeline.ts` wires ingest → extract → decide → persist as a plain async function per document, one OpenAI-SDK client pointed at OpenRouter, JSON-mode output forced through `ExtractedFieldsSchema.parse()`. A failed extraction or schema mismatch is caught and downgraded to a `FAILED` verdict rather than throwing.
**D-11 — Cost Model:** Hardcoded per-model token-price table (`PRICING_MAP`) computed at trace time — simpler and fully auditable, at the cost of going stale if OpenRouter repricing isn't manually reflected.
**D-12 — Dual-Model Comparison Harness:** `eval.ts` runs every gold-set document through two configurations — Pass A (Qwen alone) and Pass B (Qwen + GLM, escalating to human on disagreement) — against the hand-authored `specs.json` ground truth, printing per-document pass/fail plus aggregate accuracy and a 10k-item/month cost projection.
