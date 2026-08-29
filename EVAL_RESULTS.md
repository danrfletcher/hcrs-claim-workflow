# Evaluation result

Run: 2026-08-29T07:01:08.715Z · gold set: 20 documents · traces in `./traces/`

Both configurations are scored from the **same extraction pair per document**, so the only
variable between them is the reconciliation step, not extraction noise. This is a paired
ablation over n=20, not a randomised A/B test — directional evidence about a mechanism, not a
powered statistical claim.

## Why two numbers and not an accuracy score

Reconciliation never invents a better verdict. When both models agree, the answer *is* the
primary model's answer; the only thing dual-pass ever changes is converting a committed verdict
into an escalation. Under a single `verdict == gold` accuracy score every escalation counts as a
miss, so dual-pass is arithmetically incapable of winning — the metric would be measuring
willingness to guess, not correctness. Scored properly, escalation is a **trade**: it costs
handler minutes and buys back a wrong answer. So the comparison reports what the trade cost and
what it bought.

| metric                    | A: single-pass | B: dual-pass  | what it means                                                                                                                                           |
| ------------------------- | -------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Harmful errors**        | 4/20 (20.0%)   | 3/20 (15.0%)  | Auto-decided ELIGIBLE↔NOT_ELIGIBLE the wrong way. A claim wrongly pursued or wrongly closed. **Lower is better — this is the number that costs money.** |
| Soft errors               | 3/20 (15.0%)   | 2/20 (10.0%)  | Auto-decided wrong, i.e. INSUFFICIENT_DATA but recoverable — sends someone to chase more paper.                                                         |
| **Automation rate**       | 20/20 (100.0%) | 17/20 (85.0%) | Share auto-decided at all. **Higher is better — this is what escalation costs you.**                                                                    |
| Escalated to human        | 0/20           | 3/20          | Routed to a person. Not an error — a trade.                                                                                                             |
| Extraction failures       | 0/20           | 0/20          | Both passes broke.                                                                                                                                      |
| Precision when committing | 65.0%          | 70.6%         | Of the documents it *did* decide, how often it was right.                                                                                               |
| Cost / 20 docs            | $0.0101        | $0.0178       | Measured, not estimated.                                                                                                                                |
| Cost / item               | $0.00050       | $0.00089      |                                                                                                                                                         |
| **Projected 10k/month**   | **$5.03**      | **$8.88**     | Extraction step only — see DECISION_LOG.md Q3.                                                                                                          |

## The trade

- **2** escalation(s) caught a verdict single-pass got wrong.
- **1** escalation(s) were waste — single-pass already had it right.
- Net: **1 harmful error(s) avoided** for **3 extra escalation(s)** and **$0.0077** more inference across 20 documents.

## Which one won

See `DECISION_LOG.md` Q4 for the exchange rate this is judged under and the resulting call.
