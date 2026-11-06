# Installation, operation, and Firefox validation

This guide covers **version 0.3.1** of the ChatGPT Conversation Exporter for Tampermonkey and Greasemonkey. The original paginated JSON exporter has been tested in Firefox, with full-message comparison across batching modes. A real user-uploaded 7z attachment was also downloaded successfully with the updated project-aware attachment resolver. **Other file types are best effort and need additional browser checks.** Node CI cannot reproduce live API permissions or browser download behavior.

## Requirements

- Firefox with **Tampermonkey** or **Greasemonkey 4.11+**.
- A signed-in session at `https://chatgpt.com` and access to an **original** conversation.
- Sufficient memory and disk space for potentially large raw JSON.
- No third-party runtime dependencies.

The userscript uses `GM_registerMenuCommand` / `GM.registerMenuCommand` for the optional menu action, and `GM_getValue` / `GM_setValue` or `GM.getValue` / `GM.setValue` for explicitly saved settings.

## Install or update

1. Open [the installable userscript on `main`](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/main/userscripts/chatgpt-conversation-export.user.js) and install or update it with your userscript manager. If the raw page does not invoke installation, copy the source into the manager's userscript editor.
2. Ensure **only one active copy** of the exporter is installed. Do not leave older and newer versions enabled simultaneously.
3. Open `https://chatgpt.com/c/<conversation-id>` or an original `/g/.../c/<conversation-id>` conversation and **reload the tab** after installing or updating.
4. Find the compact **Export chat as JSON** launcher at the bottom right, next to a **transparent SVG gear**. If the optional menu command is unavailable, use the page launcher instead. A Tampermonkey dropdown beside a script name may show management actions only.

This development release intentionally has no explicit `@updateURL` or `@downloadURL`; use the repository link above to update.

## Export a conversation

1. Click **Export chat as JSON** while viewing the original conversation. No export starts on page load.
2. The progress panel displays **API pages** (backend pagination responses) and **message records** (technical message objects); these are *not* synonymous with conversation turns or browser pages. Messages are collected sequentially and the progress text no longer says **"checking for older pages"**.
3. **Cancel** interrupts the current run; restart the export from the same conversation and tab to resume previously validated pages. **Close** dismisses the panel but **does not cancel** the export. The **Dots** activity animation remains visible in the launcher even while the panel is closed. Clicking Export while a run is active reopens the panel rather than starting another export.
4. On completion, the panel displays **Save performance report**, while **Cancel** is hidden. The browser downloads a ZIP containing `chatgpt-conversation-<conversation-id>.json`. If ZIP compression fails or is unsupported, the exporter downloads **plain JSON** and explicitly reports the fallback.
5. The completion line displays **whole-second active duration**, **JSON uncompressed** (UTF-8 byte size in MiB), and downloaded **ZIP** or **JSON** size. For instance:

   ```text
   Export complete – ZIP download started.
   26 API pages, 2795 unique message records;
   Duration: 2m 23s (active); JSON uncompressed: 32.85 MiB;
   ZIP 3.56 MiB – chatgpt-conversation-<id>.zip
   ```

   Values above are illustrative. Active time sums multiple resumed runs but **excludes time paused between them**. The report's final `active_run_ms` can be slightly higher because it is finalized afterward.
6. Open the downloaded JSON (inside ZIP if applicable). Confirm that `messages` is an array, `page_metadata` exists, `local_export_audit.pagination_verified === true`, and the unique record count seems plausible. Spot-check the earliest and latest messages if necessary.

**Important:** Clicking Export again with unchanged settings in the *same completed tab* can produce a fresh ZIP **without a new API download**. To measure a new full export, **reload the tab** first.

## Export performance settings

The **gear to the immediate right of the launcher** has no visible button chrome (background, border, or shadow). It is a semantic keyboard-accessible button containing a monochrome eight-tooth SVG. The icon follows the live ChatGPT text color in light/dark themes.

A subtle **`v0.3.1`** appears in the **bottom-right corner** of the settings panel, below the status message. It matches the userscript metadata and performance report version. The attachment checkbox is labeled **Include attachments**, without the former “(experimental)” suffix; the behavior remains opt-in and best effort.

The panel intentionally contains **only two numeric inputs**:

| Field | Default | Allowed | Meaning |
| --- | ---: | ---: | --- |
| Turns | 3 | Integer 1–1000 | Logical conversation turns requested per API response |
| Delay (ms) | 100 | Integer 0–60000 | Pause between consecutive API pages |

- **Editing** valid values changes the **next export** immediately, but only for the current session. `sessionStorage` usually preserves them across F5 within that tab.
- **Save** explicitly persists both values in Tampermonkey/Greasemonkey storage for future sessions.
- **Load defaults** applies **3 / 100** to the current session only. To overwrite any previously saved permanent values with defaults, click **Save** afterward.
- Pre-v0.2.0 preferences are read as a compatibility fallback. There is no automatic write to the new durable key.
- While an export is running, the numeric fields and both actions are disabled.
- A change of effective parameter values requires a new API session on the next export; unchanged parameters keep the in-memory export for resume or another download.

Higher batch sizes may cause slow or oversized responses. **Only values up to 3 turns have measured reliability evidence.** The upper bound of 1000 is a technical input limit, not a recommendation.

A new browser tab normally loads the durable saved values rather than unsaved changes made in another tab. Some browsers restore session storage when restoring tabs; that may preserve session-only values longer than an ordinary new tab.

## Optional attachment exports (v0.3.0; best effort)

**Version 0.3.0** includes a default-OFF **Include attachments** checkbox below Turns and Delay in the gear panel. Setting the checkbox is session-only until **Save** is clicked. **Load defaults** turns it off; Save after loading defaults makes this choice permanent.

Install the [released build from `main`](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/main/userscripts/chatgpt-conversation-export.user.js) as an **update/replacement** for the existing userscript, not as a second active copy.

When enabled, the ZIP includes the unchanged conversation JSON, `attachments-manifest.json`, and zero or more numbered entries under `attachments/`. File references are discovered from structured message attachments/asset pointers and assistant `sandbox:/mnt/data/...` links. The binary fetch is **best effort**, not a completeness guarantee; unavailable and expired files are recorded in the manifest. Only carefully validated signed URLs on ChatGPT's `oaiusercontent.com` raw-file CDN are followed without credentials; arbitrary external URLs are still refused.

Files are limited to **100 attempted references**, **50 MiB each**, **200 MiB total**. The archive is still a valid ZIP if DEFLATE is unavailable (with stored/uncompressed entries). Cancelling interrupts both conversation pagination and subsequent file retrieval. A multi-ZIP packaging error triggers a clearly indicated conversation-only fallback. Avoid uploading ZIPs or manifests containing private conversation information to GitHub.

### Manual Firefox/Tampermonkey acceptance

- [ ] Verify version 0.3.1 and that the checkbox defaults to **off** on a new installation.
- [ ] The attachment option shows a **visible empty square** to the left of its label, regardless of ChatGPT light/dark theme. Clicking makes it blue with a white checkmark; clicking again clears it. **Tab + Space/Enter** also toggles it, and `aria-checked` follows the visual state.
- [ ] With checkbox **off**, export a known conversation; ZIP still has exactly one conversation JSON file and its content matches the main-branch export.
- [ ] Upload a small ordinary file (e.g., a text file or PDF) to a test conversation; enable the checkbox and export. Inspect the manifest; confirm the file is present under `attachments/` and its bytes match the original.
- [ ] Re-test the upload that previously returned `metadata HTTP 404`. The new manifest should show which safe resolver routes were tried (`files-by-id`, `conversation-attachment`, `files-download`) and `resolved_by` if successful. If all return 404, **do not assume** the original file is deleted; the backend route or access policy may differ.
- [ ] A logged-in browser session's Bearer header is used for same-origin file metadata and content requests when present. No token or signed download URL is written into the manifest.
- [ ] A 401/403 should stop further resolver probing for that file; only 404/410 permits trying alternative metadata routes.
- [ ] Ask the assistant to generate a small CSV linked as `sandbox:/mnt/data/...`; export with the option enabled. Check whether the interpreter download succeeds; if not, the manifest should show a failed item rather than falsely claiming success.
- [ ] Repeat with a user-uploaded image and, if available, an assistant-generated image; document which file-pointer variants are recognized.
- [ ] Delete or make a referenced file inaccessible; check the manifest shows the missing file without omitting conversation JSON.
- [ ] Check displayed **Attachments: N/M downloaded** and any partial-download warning.
- [ ] Confirm invalid/foreign redirect URLs are never followed and no signed download URL or access token appears in the manifest.
- [ ] Test **Cancel** while a file is downloading; it must not create a falsely complete archive.
- [ ] Confirm **Save** persists the checkbox; **Load defaults** clears it only for the session unless saved again.
- [ ] Compare a multi-file ZIP and a plain conversation ZIP using `node scripts/compare-exports.js`; it must compare the conversation messages and ignore attachment binaries.

These steps **have not yet been verified with live ChatGPT files**. The download APIs are unofficial and may differ by account or file type.

## Diagnosing the original HTTP 403 (beta.4, before HAR evidence)

A user-uploaded 7z file was found, but the `files-by-id` resolver returned HTTP 403. The exporter stops on this response; it cannot infer whether the cause is an unsupported route, a missing workspace context, or restricted file access. **A 403 is not evidence that the original file was deleted.**

1. Update to **v0.3.0**, reload the original chat and run the opt-in attachment export once.
2. Open `attachments-manifest.json`; inspect only `source`, `reference_keys`, `auth_mode`, `conversation_scope`, `resolver_http_statuses`, `resolved_by` and `error`.
3. In Firefox **Developer Tools → Network**, enable **Preserve logs** and try the ordinary **ChatGPT UI attachment download** for that same file (if offered). Identify the request associated with that click. Compare the **endpoint path**, **HTTP status**, and **presence/absence** of the `chatgpt-account-id` request-header name with the failed request from the exporter. If the UI download is also denied, the exporter cannot solve an underlying access restriction.
4. Share **only** redacted endpoint paths and status codes if needed. Never paste a full HAR, `Authorization`, `Cookie`, signed `download_url`, query parameters such as `sig` or `token`, or private file contents.

Some Teams/Project file downloads require a valid project or workspace context; that is documented in third-party projects but **not yet established for this particular upload**. Do not guess account IDs or bypass 401/403 responses by repeatedly probing unrelated endpoints.

## Firefox HAR findings and beta.5 acceptance

The user-supplied HAR (analyzed locally, **not committed**) captured a successful UI-initiated file download in a project conversation:

1. An earlier `/backend-api/files/{file_id}/simple` probe returned **HTTP 404**.
2. `/backend-api/conversation/{conversation_id}/attachment/{file_id}/download?gizmo_id={project_id}` returned **HTTP 200** with JSON containing a short-lived signed `download_url`.
3. A request to a regional `*.oaiusercontent.com/files/{uuid}/raw` URL returned **HTTP 200** with the binary.

The metadata request also included Bearer authentication and a `ChatGPT-Account-Id` header. The released exporter uses its existing session authentication, derives the project gizmo ID from the original ChatGPT conversation URL, and allows the signed CDN URL **without forwarding credentials**. It does not manufacture missing account headers. **The original 7z file was subsequently downloaded successfully via the userscript in Firefox/Tampermonkey.** Other CDN endpoints, accounts and file types may behave differently.

- [ ] On a fresh install of **v0.3.0**, re-export the same or another chat with attachments enabled.
- [ ] Confirm that a `metadata-id` upload in a project tries `conversation-attachment` **first**, with a valid `gizmo_id` parameter.
- [ ] If metadata resolves, confirm that the signed `oaiusercontent.com` URL downloads the original bytes without carrying Bearer or cookies.
- [ ] Compare the downloaded file's checksum/size to a file downloaded directly from ChatGPT; inspect `attachments-manifest.json` for `status: downloaded` and the resolver path.
- [ ] If it fails, share only safe manifest diagnostic fields, notably `resolver_routes_tried`, `resolver_http_statuses` and `error`. If the metadata call still returns **403**, investigate the legitimate account-context header instead of probing more endpoints.
- [ ] Check that the ordinary conversation JSON and its offline equality comparator remain valid, even when a file fails.

**Security: Never share an unredacted HAR.** It can include live session cookies, authorization tokens and signed download URLs. After accidental exposure, revoke the affected active sessions through ChatGPT security settings and log back in. Do not add HAR files to GitHub or tests.

## Validate two exports offline

Use **Node.js 22+** and the local comparison script:

```powershell
node .\scripts\compare-exports.js "C:\path\old.zip" "C:\path\new.zip"
```

The script supports `.zip` and `.json`, verifies ZIP CRC32, compares **all message IDs**, canonical message objects and message order, and ignores expected differences in pagination metadata and export timestamps. It outputs only counts and a verdict, not private IDs or message content. Exit codes: `0` identical, `1` different, `2` malformed input or execution error.

For one real 5,329-message-record conversation the user independently confirmed that exports with **2 turns / 100 ms**, **2 turns / 250 ms**, and **3 turns / 100 ms** have identical IDs, messages and order. This does not eliminate the need to verify different conversations when changing API batching.

## Manual browser acceptance checklist

- [ ] Only one script instance is active, and v0.2.3 loads without errors after F5.
- [ ] Compact launcher and **transparent gear immediately on its right** appear without covering native ChatGPT controls.
- [ ] The SVG gear is legible in **light and dark ChatGPT themes**, has no ship-wheel/emoji styling, and works with mouse and **Tab + Enter/Space**. Keyboard focus remains visible.
- [ ] Gear panel shows **Turns**, **Delay**, the opt-in **Include attachments** checkbox and **v0.3.1** in the small footer; defaults **3 / 100**, attachments disabled, no presets.
- [ ] Unsaved changes to **5 / 200** persist after F5 in the same tab, but do not unexpectedly overwrite permanent preferences.
- [ ] **Save** persists values across new sessions; **Load defaults** resets only the session until another Save.
- [ ] Invalid inputs (e.g. Turns 0, Delay −1, fractional values) are rejected; valid Turns 4 or 10 are accepted.
- [ ] Settings controls become disabled during export and enabled again afterward.
- [ ] A small original chat downloads successfully; no automatic download occurs on page load.
- [ ] During export, progress text contains **only API pages and message records**, without "checking for older pages".
- [ ] **Cancel** is visible only during an active run; **Save performance report** appears only after stopping. **Close** is always available.
- [ ] Dots animate while fetching, retrying and compressing, even with the progress panel closed. They stop on success, cancellation or error; reduced-motion settings make dots static.
- [ ] Closing and reopening an active progress panel **does not start additional requests**.
- [ ] Closing a completed panel and downloading the same in-memory chat again does not show a stale grey Cancel button.
- [ ] Final status displays **whole seconds**, properly carries `59.8s → 1m 0s`, and shows both **uncompressed JSON** and actual downloaded file size in MiB.
- [ ] ZIP opens and contains exactly one valid JSON file; CRC32 and export audit are correct.
- [ ] When browser-native compression is unavailable, the fallback is visibly labeled **JSON**, never an invalid ZIP.
- [ ] **Save performance report** creates a JSON with counts/times, no private chat IDs/contents/tokens, only after explicit user action.
- [ ] A long chat reaches `has_previous_page=false` without cursor loops; a cancelled export resumes in the same tab.
- [ ] Navigating to a different original conversation starts a separate session and filename.
- [ ] Shared links or non-conversation URLs fail safely.
- [ ] No conversation content or authentication credentials are sent to other origins or committed to Git.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Launcher absent | Verify the installed version and whether ChatGPT was reloaded; disable duplicate scripts |
| Userscript menu item absent | Use the in-page launcher; some managers expose only script-management commands |
| HTTP 401/403 | Check login and browser sandbox permissions; never share access tokens |
| HTTP 500/timeout | The exporter retries temporary failures and can fall back to smaller batches |
| Missing/repeated cursor or malformed page | The exporter intentionally refuses a purportedly complete download rather than silently skipping pages |
| Download does not appear | Check browser download permissions and save settings; test Firefox/Tampermonkey downloads |
| Cancelled/interrupted export | Resume in the same tab and original conversation; a full reload clears cached pages |
| Performance report lacks ZIP/serialization metrics | Those fields are available only after successful download preparation |
| A `.json` rather than `.zip` downloads | Native `CompressionStream('deflate-raw')` is unavailable or failed; the plain JSON fallback is intentional |
| API pages vary in message count | `num_turns` controls logical turns, not the number of technical message objects |

## Privacy reminder

A raw export may contain sensitive personal, conversational or tool data. **Do not upload it to GitHub or post it in a public issue.** Performance reports omit identifying content, but still contain timestamps and behavioral timings; review before sharing.
