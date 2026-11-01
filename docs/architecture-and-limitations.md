# Architecture, data contract, and limitations

## Purpose and scope

A standalone Tampermonkey/Greasemonkey userscript exports **only the original ChatGPT conversation currently open in the browser**. It accesses the signed-in browser session and an **undocumented internal paginated message endpoint**, not the visible DOM. Neither API stability nor comprehensive historical branch coverage is guaranteed.

## Components

| File | Responsibility |
| --- | --- |
| \`src/exporter-core.js\` | Original-conversation URL validation, authenticated pagination, retries, cursor validation, deduplication, in-tab resume and export audit |
| \`src/profiling.js\` | Privacy-preserving request/page timings, counters and active-run tracking |
| \`src/compression.js\` | Single-entry ZIP32 output with UTF-8 filename, CRC32 and browser-native DEFLATE; lossless plain-JSON fallback |
| \`src/userscript-entry.js\` | Tampermonkey/Greasemonkey integration, launcher, gear settings, progress panel, cancellation, downloads |
| \`scripts/compare-exports.js\` | Offline ZIP/JSON integrity and message equality comparator |
| \`scripts/build-userscript.js\` | Deterministic assembly of source modules and userscript metadata |
| \`userscripts/chatgpt-conversation-export.user.js\` | Generated installable bundle; do **not** edit it independently |
| \`tests/*.test.js\` | Synthetic unit/UI regressions and ZIP verification; no real conversation data |

The launcher is deliberately small, with an **11-pixel label** and a **transparent, borderless, shadow-free SVG gear** directly to its right. The gear is a semantic button with accessible name and keyboard focus treatment. The eight-tooth icon draws with \`currentColor\`; the toolbar resolves ChatGPT's text color using \`var(--text-primary, var(--token-text-primary, inherit))\`. No separate theme polling or fixed light/dark color is needed.

The animated **Dots** indicator stays tied to the active export controller rather than the dismissible progress panel. Dots become static under \`prefers-reduced-motion: reduce\`. **Close** hides only the panel. Clicking Export during a running export reopens it without starting duplicate HTTP requests. **Cancel** is visible only during execution; **Save performance report** appears after success, failure, or cancellation.

## Pagination flow

\`\`\`mermaid
flowchart TD
    A[User clicks Export] --> B{Original conversation URL?}
    B -->|No| Z[Show error; do not fetch]
    B -->|Yes| C[Read browser session]
    C --> D[Request one messages API page]
    D --> E{Response valid?}
    E -->|No, retryable| F[Retry or fall back to one turn]
    F --> D
    E -->|Yes| G[Record validated page]
    G --> H{has_previous_page?}
    H -->|Yes| I[Use start_cursor as before cursor]
    I --> D
    H -->|No| J[Reverse page order and deduplicate IDs]
    J --> K[Build JSON and pagination audit]
    K --> L[Create ZIP or plain JSON fallback]
    L --> M[Download and report completion]
\`\`\`

1. Accept \`https://chatgpt.com/c/<uuid>\` and original chats nested beneath \`/g/.../c/<uuid>\`; strip query and fragment. Reject shared links.
2. Authenticate using the existing browser context: \`GET /api/auth/session\`, \`credentials: include\`; any optional Bearer token remains in memory.
3. Fetch \`GET /backend-api/conversations/{id}/messages?include_has_versions=true&num_turns=N\`. Page requests are **strictly sequential**, because the cursor for the next request comes from the preceding response.
4. While \`page_info.has_previous_page === true\`, pass \`page_info.start_cursor\` through \`before=\`. End only when the backend explicitly reports \`has_previous_page === false\`.
5. Check every page, reject missing/repeated cursors and malformed/empty responses. Identical overlapping message IDs may be deduplicated; conflicting IDs cause an error.
6. Reverse the **order of API pages**, preserve the order of messages *within* each page, and assemble the export with an audit.

An **API page** is one backend response—not a browser page, logical turn, or single message. The number of technical **message records** returned per page varies and can be large. During retrieval the status simply reads, for example, \`2 API pages, 147 message records\`; the exporter is not running an additional "checking for older pages" operation.

## Performance tuning and persistence

The settings panel contains only:

| Parameter | Default | Allowed | Explanation |
| --- | ---: | ---: | --- |
| Turns / \`num_turns\` | 3 | 1–1000 integer | Requested logical conversation turns per backend response |
| Delay / \`requestDelayMs\` | 100 ms | 0–60000 ms integer | Configured delay between nonfinal page requests |

Valid edits apply to **the next export** immediately but are stored initially only in tab \`sessionStorage\` under \`chatgpt-conversation-exporter.session-settings.v2\`. When storage is unavailable, in-memory state remains usable for the current page.

The **Save** button explicitly writes \`{numTurns, delay}\` to the userscript manager under \`chatgpt-conversation-exporter.settings.v2\`, using \`GM_setValue\`/\`GM.setValue\`. **Load defaults** loads **3 / 100** into the current session but does **not** overwrite durable preferences; users may click **Save** afterward. Old v0.1.12 preferences under \`settings.v1\` are read as a migration fallback, without silently writing new preferences.

While an export runs, both inputs and buttons are disabled. A real parameter change invalidates the current in-memory pagination session **at the next export start**; unchanged values preserve the session for resume or a repeated ZIP download. Repeating an already completed export with the same parameters does **not** re-fetch HTTP pages; reload the tab before timing a new full run.

**Do not interpret the 1000-turn ceiling as a validated optimum.** Successful same-conversation comparisons currently support one-, two-, and three-turn requests. Higher values may increase response latency, memory use, rate limiting or timeout risk.

The **core library's own defaults** remain \`numTurns=1\` and \`requestDelayMs=250\`, independent of the UI's current **3 / 100** defaults. Following two consecutive retryable 5xx/network failures for the same page, the exporter switches to \`num_turns=1\` for the remainder of that session. HTTP 429 alone does not trigger this downgrade. Network and HTTP 429/500/502/503/504 failures otherwise use bounded retries (up to four attempts per page).

## Completion status and duration

After successful download preparation the progress panel reports the API-page count, unique record count, **active export duration rounded to whole seconds**, **uncompressed UTF-8 JSON bytes converted to MiB**, and **actual downloaded ZIP or JSON bytes converted to MiB**.

\`\`\`text
Export complete – ZIP download started.
26 API pages, 2795 unique message records;
Duration: 2m 23s (active); JSON uncompressed: 32.85 MiB;
ZIP 3.56 MiB – chatgpt-conversation-<id>.zip
\`\`\`

The time is taken from the same active-run basis as \`summary.active_run_ms\`: already finished active periods plus the elapsed portion of the current run. It excludes pauses between cancellation and resume. The displayed seconds are rounded once from total milliseconds and then split into hours, minutes and seconds; e.g. 59.8 s displays as \`1m 0s\`. The performance report can differ slightly because finalization happens after the completion message. If ZIP is unavailable, the status truthfully labels the download as plain \`JSON\`.

The sample counts and sizes above are illustrative.

## Output schema

\`\`\`json
{
  "export_format": "chatgpt-paginated-conversation-v2",
  "source_url": "https://chatgpt.com/c/<conversation-id>",
  "conversation_id": "<conversation-id>",
  "messages": [],
  "page_metadata": [],
  "local_export_audit": {
    "exported_at": "...",
    "pages_loaded": 0,
    "raw_records": 0,
    "unique_records": 0,
    "duplicate_records": 0,
    "pagination_verified": true,
    "attachments_fetched_separately": false
  }
}
\`\`\`

This is an **illustrative schema**, not a realistic completed export. \`page_metadata\` retains original response metadata, including \`page_info\`. Message objects remain intact. Because only page order is reversed, no global chronological ordering across all conversation branches is promised.

\`pagination_verified: true\` means **the backend reported the end of the fetched older-page chain**. It does not prove that all historical versions, alternative branches, or external attachments were captured. \`attachments_fetched_separately\` is always \`false\`.

## ZIP packaging

The exporter creates one ZIP32 archive containing exactly one JSON file. It writes the ZIP local header, central directory and end record, uses UTF-8 filenames, checksums with CRC32, and compresses with \`CompressionStream('deflate-raw')\`. No third-party libraries or external services are required. If compression is unavailable or fails, it explicitly downloads **unchanged plain JSON** rather than creating a mislabeled or invalid ZIP. ZIP64 payloads (over approximately 4 GiB) are not supported.

## Privacy-preserving diagnostics

\`Save performance report\` is available only after the active export stops and never downloads automatically. The generated \`chatgpt-export-performance-<timestamp>.json\` includes:

- \`requests\`: page ordinal, attempt ordinal, HTTP status, time to response headers, JSON body read/parse time, \`num_turns\`, and available \`Content-Length\`.
- \`pages\`: record count, cumulative count, attempts, fetch/parse times and configured request delay for each validated page.
- \`summary\`: completed page/record counts, retries, HTTP statuses, fetch P50/P95, active-run time across resumptions, JSON serialization and ZIP compression times, JSON/ZIP byte counts and compression ratio.

The report **excludes** conversation URLs, IDs, cursors, message IDs or content, authentication tokens, and HTTP headers. It **does include** timestamps and usage patterns; review reports before sharing.

\`fetch_ms\` measures the client-observed time to HTTP response headers, **not pure server processing**. \`parse_ms\` includes body reading and JSON parsing. Without server-side or network instrumentation, DNS, TLS, server computation and browser scheduling cannot be isolated. Reported percentile values summarize observations and are not statistical guarantees.

For a local content-integrity comparison of two complete ZIP/JSON exports, use \`node scripts/compare-exports.js <baseline> <candidate>\`. The script verifies ZIP CRC32 and compares canonical message objects and order without printing IDs or contents.

## Security and operational limitations

- Match scope is \`https://chatgpt.com/*\`; requests remain on the ChatGPT origin.
- No export begins on page load: a click or userscript-manager menu action is required.
- If the conversation changes mid-export, further collection stops to prevent mixing chats.
- Validated pages survive cancellation/temporary failures **only in the same tab's RAM**. Reload loses the page cache.
- ZIP and JSON exports may contain sensitive messages, tool records, paths and personal information. **Never commit or share private exports without review.**
- Endpoints and response schemas are undocumented and can change or time out.
- User-reported Firefox/Tampermonkey successful export and same-content comparisons exist, but the current UI changes still warrant a final browser smoke test; automated CI does not validate browser sandbox restrictions or actual download permissions.

## Evidence

The original browser-console V2 exporter was used twice on a long conversation on 2026-10-31: **64 API pages, 4,970 distinct records, no duplicates, 55.35 MiB**, and a confirmed terminal cursor. A nonpaginated endpoint previously returned HTTP 500 / request timeout. Later controlled reports for one 5,329-record conversation showed **330.084 s** at **1 turn / 250 ms** versus **185.590 s** at **2 turns / 100 ms**; a **3 turns / 100 ms** run achieved approximately **158.8 s** with 19 pages and zero retries. Local ZIP comparisons confirmed identical full messages and order between the tested one-conversation **2/100, 2/250 and 3/100** exports.

These results describe particular runs, not general performance promises. See [performance baseline](performance-baseline-2026-11-01.md) for details.
