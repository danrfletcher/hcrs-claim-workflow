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
