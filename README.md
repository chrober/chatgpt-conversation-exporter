# ChatGPT Conversation Exporter

A standalone **Tampermonkey/Greasemonkey userscript** that exports **one currently open, original ChatGPT conversation** as JSON. It is not an account-wide export, and it never starts an export automatically on page load.

> **Version 0.2.3.** The exporter and its pagination flow have been used with Firefox and Tampermonkey. Automated tests cover the current implementation; verify new UI styling and browser-specific download behavior in your own browser. The internal ChatGPT API is undocumented and may change without notice.

## Install and use

1. Install **Tampermonkey** (recommended) or **Greasemonkey 4.11+** in Firefox.
2. [Install the userscript from `main`](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/main/userscripts/chatgpt-conversation-export.user.js), or open [the generated userscript](userscripts/chatgpt-conversation-export.user.js) and install it through your userscript manager. **Update/replace** an earlier installation; do not enable duplicate copies.
3. Sign in at [chatgpt.com](https://chatgpt.com) and open an **original conversation** with a URL such as `/c/<uuid>` or `/g/.../c/<uuid>`. Reload the tab after installation or update.
4. Click the compact **Export chat as JSON** button at the bottom right. The transparent gear immediately to its right opens **Export performance**, containing only **Turns** and **Delay**. Defaults are **3 turns / 100 ms**.
5. The progress panel shows counts of **API pages** and **message records**. **Cancel** stops the active run; clicking Export again resumes validated pages in the same tab. **Close** dismisses only the panel, **not** the export; animated **Dots** in the launcher remain visible while the export runs. Click the launcher again to reopen the panel without starting a duplicate request.
6. After the API confirms the end of pagination, the browser downloads a ZIP containing one JSON file. If ZIP compression is unavailable, the exporter explicitly downloads the original uncompressed `.json` instead. Check the downloaded file.

An optional userscript-manager menu action, **Export current chat as JSON**, starts the same operation where supported.

The completion message includes **active duration rounded to whole seconds**, **uncompressed JSON size**, **downloaded ZIP/JSON size**, API-page count, record count, and the filename. Example (illustrative values):

```text
Export complete – ZIP download started.
26 API pages, 2795 unique message records;
Duration: 2m 23s (active); JSON uncompressed: 32.85 MiB;
ZIP 3.56 MiB – chatgpt-conversation-<id>.zip
```

Active duration sums time spent exporting across resumed attempts but **does not include time paused between attempts**. It is measured as the download starts, so a later performance report can show a slightly longer active duration. During retrieval the progress message simply reports page and record counts; there is no separate "checking for older pages" phase.

See [installation, validation, and troubleshooting](docs/installation-and-validation.md).

## Performance settings and persistence

The gear is an accessible, borderless SVG icon using the current ChatGPT text color (`currentColor` and CSS theme tokens); it has **no background, border, shadow, dropdown, or preset selection**.

| Setting | Meaning | Default | Supported range |
| --- | --- | ---: | ---: |
| **Turns** | Logical conversation turns requested per paginated API call; larger values may reduce requests but increase response size and timeout risk | **3** | Integer **1–1000** |
| **Delay (ms)** | Wait between consecutive API-page requests | **100** | Integer **0–60000** |

Changing a valid value updates the **next** export immediately, but is **session-only** until explicitly saved. The current tab uses `sessionStorage` (normally preserved across reloads). If access to session storage is restricted, the values remain in memory until the page closes.

- **Save:** persist both values through the userscript manager (`GM_setValue` / `GM.setValue`). Saved values are restored in future sessions.
- **Load defaults:** use **3 / 100** for the current session **without overwriting** saved values. To make these defaults permanent, click **Save** afterward.
- Previous v0.1.12 settings are read as a migration fallback, without silently rewriting the durable settings.
- Settings cannot change during an active export. Changing them between exports starts a new API session, while identical settings preserve in-tab resume and ZIP re-download behavior.

**Important:** Values greater than 3 turns are technically supported but have **not been empirically validated** for reliability. The 1000-turn upper bound is a guardrail against accidental extreme input, not a performance recommendation. Large batches and very short delays may trigger rate limits or backend timeouts.

To measure a fresh HTTP export with the *same* settings, **reload the ChatGPT tab** first. Otherwise a completed in-memory session can generate another ZIP without fetching messages again.

## Local, privacy-preserving content comparison

The performance report records counts and timings, **not message content or IDs**. For a stronger correctness check, use the local comparison CLI with **Node.js 22+**:

```powershell
node .\scripts\compare-exports.js "C:\path\baseline.zip" "C:\path\candidate.zip"
```

The comparator accepts `.zip` and `.json`, verifies ZIP CRC32, and compares message IDs, **complete canonicalized message objects**, and their order. It intentionally disregards page-layout metadata and export timestamps. It does **not** upload, log, or print message IDs or contents. Exit codes: `0` identical; `1` different; `2` input/format error.

For the measured 5,329-record conversation, the user independently confirmed **identical IDs, full message objects, and order** across **Fast (2 turns / 100 ms)**, **Pacing (2 / 250)**, and **Experimental (3 / 100)** exports. These results support the current **3 / 100** default; they do not prove optimal behavior on every conversation.

## Export behavior

- Uses the existing signed-in ChatGPT browser session and validates original conversation URLs.
- Requests the undocumented paginated message endpoint **sequentially** using `before=<page_info.start_cursor>` and `include_has_versions=true`, until `has_previous_page === false`.
- Rejects malformed pages, repeated/missing cursors, and conflicting duplicate IDs. Only identical duplicate messages are deduplicated.
- Retries temporary HTTP 429/500/502/503/504 and network failures. Two repeated retryable 5xx/network failures on the same page trigger a fallback to `num_turns=1`; 429 alone does not reduce batch size.
- Preserves validated pages **in the current tab's memory** after cancellation/error, enabling in-tab resume. Reloading the page clears this export cache.
- Generates one ZIP archive with UTF-8, CRC32, and native DEFLATE (`CompressionStream('deflate-raw')`), without runtime libraries; explicitly falls back to plain JSON when required.
- Shows **Cancel only while exporting**, and **Save performance report** after an export succeeds, fails, or is cancelled. The performance report is downloaded **only after an explicit click**. Closing the progress panel does not stop the dots or active export.
- Never retrieves attachment files separately or claims to have exported all historic conversation branches/versions.

For implementation details and privacy boundaries, see [architecture and limitations](docs/architecture-and-limitations.md). For anonymized historical measurements and their interpretation, see [performance baseline](docs/performance-baseline-2026-11-01.md).

## Development

Requires **Node.js 22 or later**, with no third-party npm dependencies:

```bash
npm run build
npm run check
```

Source modules: `src/exporter-core.js` (pagination/integrity), `src/profiling.js` (content-free metrics), `src/compression.js` (ZIP), `src/userscript-entry.js` (browser UI), and `scripts/compare-exports.js` (offline integrity check).

`scripts/build-userscript.js` deterministically produces `userscripts/chatgpt-conversation-export.user.js`. **Edit the sources and rebuild; do not edit only the generated bundle.** GitHub Actions checks JavaScript syntax, generated-bundle equality, and Node tests. CI uses pull-request events for feature branches and push events for `main`; documentation-only changes do not trigger a build.

## Security and limitations

**This tool calls undocumented ChatGPT endpoints** which can change without warning. It exports only original conversations accessible to the signed-in user, **not** `/share/...` links. The JSON may contain sensitive messages, internal tool records, personal data, filesystem paths, and references. `pagination_verified: true` means the API reported the end of the fetched older-page chain—not necessarily every historical version, branch, or attachment.

The exporter uses same-origin ChatGPT requests and creates a local Blob download. It does not transmit conversation data to GitHub or other third parties. Authentication tokens are not written to the export. **Never commit raw conversation exports, tokens, or user-specific performance reports**, and review any exported files before sharing. Performance reports omit IDs and content but include timestamps and usage timings.

For the official account-wide export, use **ChatGPT → Settings → Data Controls → Export data**.

## License

MIT — see [LICENSE](LICENSE).
