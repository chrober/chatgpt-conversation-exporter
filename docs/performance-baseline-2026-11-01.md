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


## Second baseline: user's completed v0.1.7 export

A new user-supplied **0.1.7** performance report was analyzed on **2026-11-01**. The raw report is **not committed**. It pertains to a different / longer export than the first baseline; compare future experiments for *this exact conversation*, not by comparing totals from unrelated chats.

| Metric | Value |
| --- | ---: |
| Export complete | yes |
| Active elapsed time | 139,809 ms |
| Paginated API responses | 58 |
| Message records | 1,632 |
| Message API requests | 59 (58 HTTP 200, 1 network error) |
| Retries | 1 |
| Time waiting for response headers (includes session calls) | 123,645 ms |
| Body read / JSON parse | 383 ms |
| Local JSON serialization | 30 ms |
| Native ZIP compression | 581 ms |
| Plain JSON bytes | 14,356,490 |
| ZIP bytes | 1,783,445 |
| Header-wait P50 / P95 | 1,645 / 4,692 ms |
| Single-record API pages | 28 of 58 |
| Total header wait for those single-record pages | 44,786 ms |

The measured HTTP header wait is **88.4%** of active runtime. With the previous sequential 250-ms interval, nominal pacing is **57 × 250 ms = 14,250 ms**, about **10.2%** of runtime. 28 single-record pages consume about **44.8 s**, which motivates testing larger `num_turns`. The large initial API responses occasionally cost 4–6 seconds apiece; larger requests may instead be slower or hit timeouts.

### Experimental optimization introduced in v0.1.9 (feature branch only)

The **userscript** now requests `num_turns=2` and waits **100 ms** between nonterminal pages. The **core library's default remains the proven** `num_turns=1` / **250 ms**, which keeps the reference mode available to tests and integrations. After **two consecutive retryable 5xx/network errors** during a page fetch in two-turn mode, it automatically degrades to `num_turns=1` (and keeps that setting throughout the session/resume); 429 alone does **not** trigger a page-size downgrade. All cursor, pagination, deduplication, abort and resume validation is still used.

If the number of pages did not change, reduced pacing could save roughly **8.55 seconds** for the 58-page baseline. More significant gains depend on whether two-turn requests actually reduce the number of pages **without hitting backend timeouts**; this is an *unmeasured hypothesis*, not an achieved speedup.

The performance report now tracks **`requests[*].num_turns`**, **`pages[*].num_turns`**, and **`summary.requests_by_num_turns`**. These are numeric public tuning settings, not URLs, credentials, cursors or message IDs. A new report of the **same conversation**, after installing v0.1.9, is needed to validate any speedup and compare record counts, `pagination_verified`, retries and transfer sizes. One export alone does not establish general performance or safety.

A completed export re-run after **Close** now initializes the new UI state before opening the panel; regression tests ensure no stale grey Cancel remains visible after completion.
