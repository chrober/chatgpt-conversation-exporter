# Performance baseline: paginated export (2026-11-01)

This document records **aggregate-only** measurements from a user-supplied, completed **0.1.2** performance report. The original report, conversation URL, IDs, and message content are **not stored** in this repository.

## Measurements

| Metric | Observed |
| --- | ---: |
| Export completed | yes |
| API pages (backend pagination responses) | 44 |
| Message records | 638 |
| Message API requests | 44 |
| HTTP status | 44 × 200 |
| Retries | 0 |
| Client-measured HTTP header wait, including session requests | 47,183 ms |
| Response body read / JSON parse | 243 ms |
| Total active run time | 58,321 ms |
| Final JSON serialization | 11 ms |
| Export size | 4,645,058 bytes (4.43 MiB) |
| Message-fetch P50 / P95 (time to response headers) | 827 / 2,741 ms |
| Records per active second | 10.9 |

The report includes **two session-authentication requests** (133 ms and 116 ms). Active-run time excludes elapsed time between separate executions; do not treat the difference between first and final timestamps as active execution time.

### Interpretation

- HTTP header waiting accounts for approximately **80.9%** of active time. This is not a server-only latency measurement: it includes client/network overhead.
- Sequential pacing at **250 ms** after each nonterminal page should account for **43 × 250 = 10,750 ms**, approximately **18.4%** of active runtime. The difference between the reported time components and active time is compatible with these intentional pauses, but the present profiler does not report pacing separately.
- Response body/JSON parsing (**243 ms**) and final JSON serialization (**11 ms**) together account for well under **1%**; optimizing serialization is currently not justified.
- **21 of 44 pages contain just one message record**. Their summed header-wait time is **15,994 ms**. This could reflect the API's turn-/message-boundary semantics, rather than a client defect. `num_turns=1` limits logical turns, not technical message count.
- Successful completion and **zero retries** on this one run do not prove that higher request rates or larger page sizes are always safe.

## Suggested controlled performance experiments

Keep the current proven `num_turns=1` and 250-ms pacing as the **reference baseline**. Implement experiments separately (preferably opt-in), using the **same conversation** when possible:

1. **Pacing:** compare 250 ms with 100 ms and 0 ms, measuring total time, HTTP 429/5xx, retries, and correctness. A best-case ceiling from removing 250-ms pacing alone in this report is roughly **10.75 seconds**, not a promise of real-world speedup.
2. **Page size:** compare `num_turns=1`, 2 and 3 without conflating results from different chats. Verify `pagination_verified`, unique/raw counts, no conflicting IDs, and request timeouts (larger requests previously timed out on a very long chat).
3. **API-bound vs local processing:** track time to first headers and body parse separately; consider per-page payload bytes if available, without logging content.
4. **Concurrency:** assess only after correctness and cursor dependency analysis; naive parallel backward cursor paging is not possible without the cursor of the previous response.

Do not introduce optimization into the stable export path without A/B evidence. Never commit raw export JSON or the user's individual diagnostic JSON; use aggregate/redacted results for reproducibility.

## Related UX fix

Starting in **0.1.4**, **Cancel** is visibly greyed out and natively disabled when no export is running (initial/finished/cancelled/error) and returns to its active appearance only during a running export. A UI regression test exercises both states.
