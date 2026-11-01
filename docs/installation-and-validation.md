# Installation, operation, and Firefox validation

This guide covers **version 0.2.3** of the ChatGPT Conversation Exporter for Tampermonkey and Greasemonkey. A previous version was successfully used in Firefox/Tampermonkey, and multi-mode exports of the same conversation were compared for content equality. **The latest UI/status changes still need a manual browser smoke test.** Node CI tests cannot fully exercise browser download permissions, sandbox behavior, or ChatGPT theme updates.

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

## Experimental file attachments (feature branch only)

**Version 0.3.0-beta.3** adds a default-OFF **Include attachments (experimental)** checkbox below Turns and Delay in the gear panel. Setting the checkbox is session-only until **Save** is clicked. **Load defaults** turns it off; Save after loading defaults makes this choice permanent.

Install the [experimental branch build](https://raw.githubusercontent.com/chrober/chatgpt-conversation-exporter/refs/heads/feat/optional-conversation-attachments/userscripts/chatgpt-conversation-export.user.js) as an **update/replacement** for the existing userscript, not as a second active copy. The published main-branch v0.2.3 remains unaffected.

When enabled, the ZIP includes the unchanged conversation JSON, `attachments-manifest.json`, and zero or more numbered entries under `attachments/`. File references are discovered from structured message attachments/asset pointers and assistant `sandbox:/mnt/data/...` links. The binary fetch is **best effort**, not a completeness guarantee; unavailable and expired files are recorded in the manifest. External signed URLs are deliberately not followed in this first experiment.

Files are limited to **100 attempted references**, **50 MiB each**, **200 MiB total**. The archive is still a valid ZIP if DEFLATE is unavailable (with stored/uncompressed entries). Cancelling interrupts both conversation pagination and subsequent file retrieval. A multi-ZIP packaging error triggers a clearly indicated conversation-only fallback. Avoid uploading ZIPs or manifests containing private conversation information to GitHub.

### Manual Firefox/Tampermonkey acceptance

- [ ] Verify version 0.3.0-beta.3 and that the checkbox defaults to **off** on a new installation.
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
- [ ] Gear panel shows **only Turns and Delay**, defaults **3 / 100**, and no presets.
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
