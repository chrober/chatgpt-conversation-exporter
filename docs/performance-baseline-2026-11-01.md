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


## Direct same-conversation A/B result: 0.1.7 vs 0.1.9

On 2026-11-01, the user supplied **two completed performance reports of exactly the same conversation**, one from **v0.1.7** (baseline: \`num_turns=1\`, 250-ms inter-page delay) and one from **v0.1.9** (experimental: \`num_turns=2\`, 100-ms delay). **Neither raw report nor conversation data is committed**; this section records aggregate and paired statistics only.

| Measurement | v0.1.7 (baseline) | v0.1.9 (fast) | Delta |
| --- | ---: | ---: | ---: |
| Active export time | 330,084 ms (5:30.084) | 185,590 ms (3:05.590) | **−144,494 ms / −43.77%** |
| Completed API pages | 56 | 28 | **−50%** |
| Message HTTP attempts | 56 | 28 | **−50%** |
| Message records | 5,329 | 5,329 | **identical count** |
| Header-wait time incl. session | 296,627 ms | 175,925 ms | **−120,702 ms / −40.69%** |
| Response body / JSON parse | 1,398 ms | 1,078 ms | −320 ms |
| JSON serialization | 216 ms | 218 ms | +2 ms |
| ZIP compression | 5,419 ms | 5,589 ms | +170 ms |
| JSON size | 55,169,427 B | 55,156,266 B | −13,161 B (−0.024%) |
| ZIP archive size | 5,531,409 B | 5,530,086 B | −1,323 B (−0.024%) |
| Fetch P50 / P95 | 4,356 / 9,171 ms | 6,180 / 9,565 ms | Per-request slower, total faster |
| Retry attempts | 0 | 0 | unchanged |
| HTTP errors | 0 | 0 | unchanged |
| Records / active second | 16.1 | 28.7 | +78.3% |

### Page-boundary consistency check

The 56 v0.1.7 page record counts can be divided into **28 adjacent pairs**. For **every one of the 28 pairs**, the sum of the two old page record counts equals the record count of the corresponding v0.1.9 page, *in the same order*. E.g. 2+1=3, 385+1=386, 355+1=356, 160+1=161. All 28 corresponding **paired old fetch durations** exceed the duration of the single new two-turn request. The old run contains **27 one-record pages**; the new run contains **zero**.

This is strong evidence that the API returns the same *number and grouping* of records with the larger batch. **It does not prove byte-wise or message-ID equality** because the performance reports deliberately exclude message content and IDs. A definitive completeness check requires comparing the original exported JSON payloads locally; metadata and timestamps are expected to differ due to pagination layout and export times. Equal total counts alone do not guarantee identical messages.

### Attribution and limitations

Of the **144.494 s** saved in this one paired test, **120.702 s (83.5% of savings)** is the reduction in recorded HTTP header-wait time. The *configured* inter-page pacing totals change from 55×250 ms = **13.75 s** to 27×100 ms = **2.70 s**, a **nominal 11.05 s saving**. Remaining differences are not reliably attributable from the current profile fields; they may include browser scheduling, actual versus configured pacing, local assembly and other timings.

**Two variables were changed together**, page size and pacing. This one before/after comparison therefore cannot isolate their causal contributions, nor rule out backend load variation. A per-request P50 increase is expected when each request asks for more turns and does not contradict a lower total runtime.

**Result:** The improvement is **observed**, not merely projected. The two-turn mode is promising enough to continue testing, but it is still experimental pending repeated runs across multiple conversations, strict local content/ID comparisons, and robustness tests for oversized pages and 429/5xx responses.

### Next controlled experiments

1. Hold \`num_turns=2\` and compare **100-ms vs 250-ms** pacing with **the same chat**, to isolate request spacing.
2. Hold pacing at 100 ms and compare **\`num_turns=2\` versus 3** only as an opt-in experiment with current retry/fallback protection, timeouts and complete-export verification.
3. Add duration metrics for **actual inter-page sleeping** and **final JSON assembly**, to explain currently unattributed runtime.
4. Prefer local, privacy-preserving equality checks of **message IDs and canonicalized contents** between the two complete exports before designating a faster setting as a new default.

The original \`num_turns=1\` / 250-ms core defaults remain a conservative reference, and \`main\` must not be changed by these experiments.
