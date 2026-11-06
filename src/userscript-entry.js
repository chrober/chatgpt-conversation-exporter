"use strict";

// Greasemonkey/Tampermonkey UI adapter. Core embedded by build-userscript.js.
// Do not run an export automatically when ChatGPT loads.
(function installExportCommand() {
    const SETTINGS_KEY = "chatgpt-conversation-exporter.settings.v2";
    const LEGACY_SETTINGS_KEY = "chatgpt-conversation-exporter.settings.v1";
    const SESSION_KEY = "chatgpt-conversation-exporter.session-settings.v2";
    const DEFAULT_SETTINGS = Object.freeze({ numTurns: 3, delay: 100, includeAttachments: false });
    const MAX_TURNS = 1000;
    const MAX_DELAY_MS = 60000;

    function validateSettings(raw) {
        if (!raw || typeof raw !== "object" ||
            !Number.isInteger(raw.numTurns) ||
            raw.numTurns < 1 || raw.numTurns > MAX_TURNS ||
            !Number.isInteger(raw.delay) ||
            raw.delay < 0 || raw.delay > MAX_DELAY_MS) {
            return null;
        }
        return { numTurns: raw.numTurns, delay: raw.delay, includeAttachments: raw.includeAttachments === true };
    }

    function migrateLegacySettings(raw) {
        if (!raw || typeof raw !== "object") return null;
        const preset = {
            stable: { numTurns: 1, delay: 250 },
            pace: { numTurns: 2, delay: 250 },
            fast: { numTurns: 2, delay: 100 },
            experimental: { numTurns: 3, delay: 100 }
        };
        if (raw.mode === "custom") {
            return validateSettings({
                numTurns: raw.customNumTurns, delay: raw.customDelayMs
            });
        }
        return preset[raw.mode] || null;
    }

    const state = {
        session: null,
        sessionMode: null,
        numTurns: DEFAULT_SETTINGS.numTurns,
        delay: DEFAULT_SETTINGS.delay,
        includeAttachments: false,
        attachmentInput: null,
        attachmentIndicator: null,
        settingsLoaded: false,
        settingsError: "",
        settingsHint: "",
        modePanel: null,
        modeTurnInput: null,
        modeDelayInput: null,
        modeNote: null,
        saveSettingsButton: null,
        resetSettingsButton: null,
        controller: null,
        panel: null,
        profiler: null,
        launcher: null,
        launcherSpinner: null,
        exportSettled: false,
        statusText: "Ready.",
        detailText: ""
    };

    function currentUrl() {
        return window.location.origin + window.location.pathname;
    }

    function selectedConfigurationKey() {
        return state.numTurns + ":" + state.delay;
    }

    function updateSettingsNote() {
        if (!state.modeNote) return;
        state.modeNote.textContent = state.settingsError ||
            state.settingsHint ||
            (state.settingsLoaded
                ? "Changes apply to the next export in this tab. " +
                  "Save keeps them after a browser restart."
                : "Loading saved settings ...");
    }

    function updateSettingsInputs() {
        if (!state.modeTurnInput || !state.modeDelayInput) return;
        state.modeTurnInput.value = String(state.numTurns);
        state.modeDelayInput.value = String(state.delay);
        if (state.attachmentInput) {
            const toggle = state.attachmentInput;
            toggle.setAttribute("aria-checked", String(state.includeAttachments));
            toggle.style.backgroundColor = state.includeAttachments ?
                "#2563eb" : "#354152";
            toggle.style.borderColor = state.includeAttachments ?
                "#60a5fa" : "#8c99a8";
            if (state.attachmentIndicator) {
                state.attachmentIndicator.style.visibility =
                    state.includeAttachments ? "visible" : "hidden";
            }
        }
        const disabled = !state.settingsLoaded || Boolean(state.controller);
        state.modeTurnInput.disabled = disabled;
        state.modeDelayInput.disabled = disabled;
        if (state.attachmentInput) state.attachmentInput.disabled = disabled;
        state.saveSettingsButton.disabled = disabled;
        state.resetSettingsButton.disabled = disabled;
        updateSettingsNote();
    }

    function storeSessionSettings(settings) {
        // sessionStorage survives a tab reload, but is separate from
        // Tampermonkey/Greasemonkey's durable preferences.
        try {
            window.sessionStorage?.setItem(SESSION_KEY, JSON.stringify(settings));
        } catch (error) {
            // Restricted windows may have no sessionStorage; in-memory
            // settings still apply until this page is closed.
            console.warn("[ChatGPT Conversation Exporter] Session storage unavailable.", error);
        }
    }

    function applySettings(settings) {
        state.numTurns = settings.numTurns;
        state.delay = settings.delay;
        state.includeAttachments = settings.includeAttachments === true;
        storeSessionSettings({ numTurns: state.numTurns, delay: state.delay,
            includeAttachments: state.includeAttachments });
    }

    function readFields() {
        const turns = state.modeTurnInput?.value?.trim();
        const delay = state.modeDelayInput?.value?.trim();
        if (!turns || !delay || !/^\d+$/.test(turns) ||
            !/^\d+$/.test(delay)) return null;
        return validateSettings({ numTurns: Number(turns), delay: Number(delay),
            includeAttachments: state.includeAttachments });
    }

    function applyFields() {
        if (!state.settingsLoaded || state.controller) {
            updateSettingsInputs();
            return false;
        }
        const settings = readFields();
        if (!settings) {
            state.settingsError =
                "Use whole numbers: Turns 1–1000; Delay 0–60000 ms.";
            state.settingsHint = "";
            updateSettingsNote();
            return false;
        }
        applySettings(settings);
        state.settingsError = "";
        state.settingsHint = "Current tab updated; click Save for permanent settings.";
        updateSettingsNote();
        return true;
    }

    let pendingSave = Promise.resolve();
    function saveSettings() {
        if (!applyFields()) return;
        const settings = { numTurns: state.numTurns, delay: state.delay,
            includeAttachments: state.includeAttachments };
        // Serialize Greasemonkey async writes to prevent older clicks from
        // overwriting newer saved settings.
        pendingSave = pendingSave.catch(() => {}).then(async () => {
            try {
                if (typeof GM_setValue === "function") {
                    await GM_setValue(SETTINGS_KEY, settings);
                } else if (typeof GM !== "undefined" &&
                           typeof GM.setValue === "function") {
                    await GM.setValue(SETTINGS_KEY, settings);
                } else {
                    throw new Error("Userscript storage API unavailable.");
                }
                state.settingsError = "";
                state.settingsHint = "Saved permanently.";
            } catch (error) {
                state.settingsError = "Save failed; values remain session-only.";
                state.settingsHint = "";
                console.warn("[ChatGPT Conversation Exporter]", state.settingsError, error);
            }
            updateSettingsNote();
        });
    }

    const settingsReady = (async () => {
        try {
            let saved = null;
            if (typeof GM_getValue === "function") {
                saved = await GM_getValue(SETTINGS_KEY, null);
                if (saved === null || saved === undefined) {
                    saved = migrateLegacySettings(
                        await GM_getValue(LEGACY_SETTINGS_KEY, null));
                }
            } else if (typeof GM !== "undefined" &&
                       typeof GM.getValue === "function") {
                saved = await GM.getValue(SETTINGS_KEY, null);
                if (saved === null || saved === undefined) {
                    saved = migrateLegacySettings(
                        await GM.getValue(LEGACY_SETTINGS_KEY, null));
                }
            }
            const persisted = validateSettings(saved);
            if (persisted) {
                state.numTurns = persisted.numTurns;
                state.delay = persisted.delay;
                state.includeAttachments = persisted.includeAttachments;
            }
            try {
                const rawSession = window.sessionStorage?.getItem(SESSION_KEY);
                const session = rawSession ?
                    validateSettings(JSON.parse(rawSession)) : null;
                if (session) {
                    state.numTurns = session.numTurns;
                    state.delay = session.delay;
                    state.includeAttachments = session.includeAttachments;
                }
            } catch (error) {
                console.warn("[ChatGPT Conversation Exporter] Could not load tab settings.", error);
            }
        } catch (error) {
            state.settingsError = "Could not load saved settings; using defaults.";
            console.warn("[ChatGPT Conversation Exporter]", state.settingsError, error);
        } finally {
            state.settingsLoaded = true;
            updateSettingsInputs();
        }
    })();

    function hideModePanel() {
        if (state.modePanel?.isConnected) state.modePanel.remove();
        state.modePanel = null;
        state.modeTurnInput = null;
        state.modeDelayInput = null;
        state.attachmentInput = null;
        state.attachmentIndicator = null;
        state.modeNote = null;
        state.saveSettingsButton = null;
        state.resetSettingsButton = null;
    }

    function toggleModePanel() {
        if (state.modePanel?.isConnected) {
            hideModePanel();
            return;
        }
        const root = document.createElement("aside");
        root.id = "chatgpt-conversation-export-mode-panel";
        root.setAttribute("aria-label", "Export performance settings");
        Object.assign(root.style, {
            position: "fixed", right: "18px", bottom: "62px",
            zIndex: "2147483647", background: "#17202b",
            color: "#f6f7f8", padding: "12px",
            border: "1px solid #46505a", borderRadius: "8px",
            boxShadow: "0 8px 30px rgba(0,0,0,.4)",
            font: "12px/1.5 system-ui, sans-serif",
            width: "min(300px, calc(100vw - 36px))"
        });
        const heading = document.createElement("div");
        heading.textContent = "Export performance";
        heading.style.fontWeight = "700";
        heading.style.marginBottom = "8px";
        root.appendChild(heading);

        const fields = document.createElement("div");
        Object.assign(fields.style, { display: "flex", gap: "8px" });
        function addField(labelText, description, id, value, min, max) {
            const field = document.createElement("label");
            field.textContent = labelText;
            Object.assign(field.style, { display: "block", flex: "1", minWidth: "0" });
            const input = document.createElement("input");
            input.id = id;
            input.type = "number";
            input.min = String(min);
            input.max = String(max);
            input.step = "1";
            input.value = String(value);
            input.setAttribute("aria-label", labelText);
            Object.assign(input.style, {
                boxSizing: "border-box", width: "100%", marginTop: "4px",
                padding: "6px", font: "inherit", color: "#fff",
                background: "#354152", border: "1px solid #8c99a8",
                borderRadius: "5px"
            });
            input.addEventListener("input", applyFields);
            input.addEventListener("change", applyFields);
            field.appendChild(input);
            const help = document.createElement("div");
            help.textContent = description;
            Object.assign(help.style, {
                fontSize: "11px", color: "#c4cedb", marginTop: "4px"
            });
            field.appendChild(help);
            fields.appendChild(field);
            return input;
        }
        const turns = addField("Turns", "Conversation turns per API request.",
            "chatgpt-conversation-export-custom-turns",
            state.numTurns, 1, MAX_TURNS);
        const delay = addField("Delay (ms)", "Pause between API pages.",
            "chatgpt-conversation-export-custom-delay",
            state.delay, 0, MAX_DELAY_MS);
        root.appendChild(fields);

        // ChatGPT globally resets native checkbox appearance in some themes.
        // Draw our own visible square rather than relying on host form CSS.
        // A real button with role=checkbox supports Tab + Space/Enter.
        const attachmentsRow = document.createElement("div");
        Object.assign(attachmentsRow.style, {
            display: "flex", gap: "8px", alignItems: "center",
            marginTop: "12px"
        });
        const attachmentCheckbox = document.createElement("button");
        attachmentCheckbox.id = "chatgpt-conversation-export-include-attachments";
        attachmentCheckbox.type = "button";
        attachmentCheckbox.setAttribute("role", "checkbox");
        attachmentCheckbox.setAttribute(
            "aria-label", "Include attachments"
        );
        attachmentCheckbox.setAttribute("aria-checked", "false");
        Object.assign(attachmentCheckbox.style, {
            // Explicit visual box wins over native input appearance resets.
            display: "inline-flex", boxSizing: "border-box",
            position: "relative", flex: "0 0 18px",
            width: "18px", height: "18px",
            minWidth: "18px", minHeight: "18px",
            padding: "0", margin: "0",
            alignItems: "center", justifyContent: "center",
            border: "1px solid #8c99a8",
            borderRadius: "4px", backgroundColor: "#354152",
            appearance: "none", boxShadow: "none",
            color: "#fff", cursor: "pointer"
        });
        const check = document.createElementNS(
            "http://www.w3.org/2000/svg", "svg"
        );
        check.setAttribute("viewBox", "0 0 18 18");
        check.setAttribute("width", "15");
        check.setAttribute("height", "15");
        check.setAttribute("fill", "none");
        check.setAttribute("stroke", "#fff");
        check.setAttribute("stroke-width", "2.2");
        check.setAttribute("stroke-linecap", "round");
        check.setAttribute("stroke-linejoin", "round");
        check.setAttribute("aria-hidden", "true");
        const checkPath = document.createElementNS(
            "http://www.w3.org/2000/svg", "path"
        );
        checkPath.setAttribute("d", "M 3.5 9 L 7.5 13 L 14.5 5");
        check.appendChild(checkPath);
        attachmentCheckbox.appendChild(check);

        function toggleAttachments() {
            if (state.controller || !state.settingsLoaded) {
                updateSettingsInputs();
                return;
            }
            state.includeAttachments = !state.includeAttachments;
            storeSessionSettings({
                numTurns: state.numTurns, delay: state.delay,
                includeAttachments: state.includeAttachments
            });
            state.settingsHint =
                "Current tab updated; click Save for permanent settings.";
            state.settingsError = "";
            updateSettingsInputs();
        }
        attachmentCheckbox.addEventListener("click", toggleAttachments);
        const attachmentText = document.createElement("span");
        attachmentText.textContent = "Include attachments";
        Object.assign(attachmentText.style, {
            cursor: "pointer", userSelect: "none"
        });
        attachmentText.addEventListener("click", toggleAttachments);
        attachmentsRow.appendChild(attachmentCheckbox);
        attachmentsRow.appendChild(attachmentText);
        root.appendChild(attachmentsRow);
        const attachmentInfo = document.createElement("div");
        attachmentInfo.textContent = "Download available chat files into ZIP; missing files are listed in a manifest.";
        Object.assign(attachmentInfo.style, {
            fontSize: "11px", color: "#c4cedb", marginTop: "4px"
        });
        root.appendChild(attachmentInfo);

        const buttons = document.createElement("div");
        Object.assign(buttons.style, {
            display: "flex", gap: "8px", marginTop: "12px"
        });
        function addAction(label, onClick) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = label;
            Object.assign(button.style, {
                padding: "5px 9px", border: "1px solid #8c99a8",
                borderRadius: "5px", background: "#354152",
                color: "#fff", cursor: "pointer", font: "inherit"
            });
            button.addEventListener("click", onClick);
            buttons.appendChild(button);
            return button;
        }
        const save = addAction("Save", saveSettings);
        const reset = addAction("Load defaults", () => {
            if (state.controller || !state.settingsLoaded) return;
            applySettings(DEFAULT_SETTINGS);
            state.settingsError = "";
            state.settingsHint =
                "Defaults loaded for this session; click Save to persist them.";
            updateSettingsInputs();
        });
        root.appendChild(buttons);

        const note = document.createElement("div");
        note.setAttribute("role", "status");
        Object.assign(note.style, {
            color: "#c4cedb", marginTop: "8px", maxWidth: "285px"
        });
        root.appendChild(note);

        const version = document.createElement("div");
        version.id = "chatgpt-conversation-export-version";
        version.textContent = "v" + USERSCRIPT_VERSION;
        version.setAttribute("aria-label", "Exporter version " + USERSCRIPT_VERSION);
        Object.assign(version.style, {
            fontSize: "10px", lineHeight: "1.2",
            color: "#9ca9bb", textAlign: "right",
            marginTop: "7px", userSelect: "none"
        });
        root.appendChild(version);
        document.body.appendChild(root);
        state.modePanel = root;
        state.modeTurnInput = turns;
        state.modeDelayInput = delay;
        state.attachmentInput = attachmentCheckbox;
        state.attachmentIndicator = check;
        state.modeNote = note;
        state.saveSettingsButton = save;
        state.resetSettingsButton = reset;
        updateSettingsInputs();
    }

    function updateLauncherActivity() {
        // The launcher is independent of the dismissible progress panel.
        // Keep the spinner active during requests, retries and ZIP compression.
        if (!state.launcher || !state.launcherSpinner) return;
        const running = Boolean(state.controller);
        state.launcherSpinner.style.display = running ? "inline-flex" : "none";
        state.launcher.setAttribute("aria-busy", String(running));
    }

    // Keep native disabled semantics while an export is being cancelled.
    function setCancelEnabled(button, enabled) {
        button.disabled = !enabled;
        button.setAttribute("aria-disabled", String(!enabled));
        Object.assign(button.style, {
            background: enabled ? "#354152" : "#414751",
            borderColor: enabled ? "#8c99a8" : "#5d6470",
            color: enabled ? "#f6f7f8" : "#a4aab3",
            cursor: enabled ? "pointer" : "not-allowed",
            opacity: enabled ? "1" : "0.55"
        });
    }

    function showPanel() {
        if (state.panel?.root?.isConnected) return state.panel;
        const root = document.createElement("aside");
        root.setAttribute("role", "region");
        root.setAttribute("aria-label", "ChatGPT JSON Export");
        Object.assign(root.style, {
            position: "fixed",
            bottom: "68px",
            right: "18px",
            zIndex: "2147483647",
            width: "min(360px, calc(100vw - 36px))",
            background: "#17202b",
            color: "#f6f7f8",
            padding: "16px",
            border: "1px solid #46505a",
            borderRadius: "10px",
            boxShadow: "0 8px 30px rgba(0,0,0,.4)",
            font: "13px/1.45 system-ui, sans-serif",
            overflowWrap: "anywhere"
        });

        const header = document.createElement("div");
        header.textContent = "ChatGPT Conversation Exporter";
        header.style.fontWeight = "700";
        header.style.marginBottom = "8px";
        root.appendChild(header);

        const status = document.createElement("div");
        status.setAttribute("role", "status");
        status.setAttribute("aria-live", "polite");
        status.textContent = state.statusText;
        root.appendChild(status);

        const progress = document.createElement("div");
        progress.style.marginTop = "8px";
        progress.style.color = "#c4cedb";
        progress.textContent = state.detailText;
        root.appendChild(progress);

        const actions = document.createElement("div");
        actions.style.marginTop = "12px";
        actions.style.display = "flex";
        actions.style.gap = "8px";
        actions.style.flexWrap = "wrap";

        function makeButton(text, onClick) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = text;
            Object.assign(button.style, {
                padding: "6px 11px",
                border: "1px solid #8c99a8",
                borderRadius: "6px",
                color: "#f6f7f8",
                background: "#354152",
                cursor: "pointer",
                font: "inherit"
            });
            button.addEventListener("click", onClick);
            actions.appendChild(button);
            return button;
        }

        const cancel = makeButton("Cancel", () => {
            state.controller?.abort();
        });
        const saveProfile = makeButton("Save performance report", () => {
            if (state.exportSettled && state.profiler) {
                downloadProfile(state.profiler.report());
                report("Performance report downloaded.", "The report excludes chat content and identifiers.");
            }
        });
        makeButton("Close", () => {
            root.remove();
            state.panel = null;
        });
        updatePanelActions({ cancel, saveProfile });
        root.appendChild(actions);
        document.body.appendChild(root);
        state.panel = { root, status, progress, cancel, saveProfile };
        return state.panel;
    }

    function updatePanelActions(panel) {
        const running = Boolean(state.controller);
        const canCancel = running && !state.controller.signal.aborted;
        // Exactly one contextual action: Cancel during a run, Save report
        // after success, failure or cancellation. Close stays visible.
        setCancelEnabled(panel.cancel, canCancel);
        panel.cancel.hidden = !running;
        panel.cancel.style.display = running ? "" : "none";
        panel.cancel.setAttribute("aria-hidden", String(!running));

        const canSave = state.exportSettled && Boolean(state.profiler);
        panel.saveProfile.hidden = !canSave;
        panel.saveProfile.style.display = canSave ? "" : "none";
        panel.saveProfile.disabled = !canSave;
    }

    function report(message, detail = "") {
        // Keep progress up to date even while the panel is dismissed.
        // Close only hides the view; it must never abort the active export
        // or allow the next progress event to recreate the panel.
        state.statusText = message;
        state.detailText = detail;
        const panel = state.panel?.root?.isConnected ? state.panel : null;
        if (panel) {
            panel.status.textContent = message;
            panel.progress.textContent = detail;
            updatePanelActions(panel);
        }
        console.info("[ChatGPT Conversation Exporter]", message, detail);
    }

    function saveBlob(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60000);
    }

    async function download(data, signal) {
        let attachmentData = null;
        if (state.includeAttachments) {
            report("Downloading attachments ...", "Finding referenced files ...");
            attachmentData = await collectAttachments(
                data.messages, data.conversation_id, {
                    signal, fetchImpl: (...args) => fetch(...args),
                    // Diagnostic hint only; never grants access or changes
                    // which authenticated endpoints may be requested.
                    conversationScope: /\/g\/g-p-[^/]+\/c\//.test(
                        new URL(data.source_url).pathname) ? "project" : "unknown",
                    gizmoId: projectGizmoIdFromSource(
                        data.source_url, data.conversation_id
                    ),
                    onProgress: (n, total) => report(
                        "Downloading attachments ...",
                        "Attachment " + n + " of " + total
                    )
                }
            );
            // The chat JSON remains otherwise unchanged. The flag accurately
            // indicates that separate attachment retrieval was attempted.
            data.local_export_audit.attachments_fetched_separately = true;
        }
        const started = performance.now();
        const json = JSON.stringify(data, null, 2);
        const serializationMs = Math.round((performance.now() - started) * 10) / 10;
        const jsonFileName = "chatgpt-conversation-" + data.conversation_id + ".json";
        let compressed, warning = null;
        if (attachmentData) {
            try {
                const entries = [
                    { name: jsonFileName, bytes: json },
                    { name: "attachments-manifest.json",
                      bytes: JSON.stringify(attachmentData.manifest, null, 2) },
                    ...attachmentData.entries
                ];
                const zip = await compressFilesToZip(entries);
                compressed = {
                    blob: zip.blob,
                    fileName: jsonFileName.replace(/\.json$/i, ".zip"),
                    format: "zip",
                    jsonBytes: new TextEncoder().encode(json).byteLength,
                    archiveBytes: zip.archiveBytes,
                    compressionMs: zip.compressionMs
                };
                if (attachmentData.summary.failed || attachmentData.summary.skipped_limit) {
                    warning = "Some attachments were unavailable or skipped; see attachments-manifest.json.";
                }
            } catch (error) {
                // Do not lose the underlying conversation if the experimental
                // multi-file ZIP implementation cannot package the binaries.
                console.warn("[ChatGPT Conversation Exporter] Attachment packaging failed.");
                compressed = await compressJsonAsZipOrPlain(json, jsonFileName);
                warning = "Attachment ZIP failed; saved conversation only.";
            }
        } else {
            compressed = await compressJsonAsZipOrPlain(json, jsonFileName);
            warning = compressed.warning;
        }

        if (signal.aborted) {
            const error = new Error("Export cancelled during compression.");
            error.name = "AbortError";
            throw error;
        }

        if (warning) {
            console.warn("[ChatGPT Conversation Exporter]", warning);
        }
        saveBlob(compressed.blob, compressed.fileName);
        return {
            fileName: compressed.fileName,
            format: compressed.format,
            sizeMiB: (compressed.archiveBytes / 1048576).toFixed(2),
            json_bytes: compressed.jsonBytes,
            archive_bytes: compressed.archiveBytes,
            compression_ms: compressed.compressionMs,
            serialization_ms: serializationMs,
            attachments: attachmentData ? attachmentData.summary : null,
            warning
        };
    }

    function formatDuration(milliseconds) {
        // Round once, then split the total into units. This handles carries
        // correctly (e.g. 59.8s becomes 1m 0s, not 0m 60s).
        const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor(totalSeconds / 60) % 60;
        const seconds = totalSeconds % 60;
        if (hours) return hours + "h " + minutes + "m " + seconds + "s";
        if (minutes) return minutes + "m " + seconds + "s";
        return seconds + "s";
    }

    function downloadProfile(profile) {
        // Profiling JSON contains only counters and timings, never raw messages.
        const blob = new Blob([JSON.stringify(profile, null, 2)], {
            type: "application/json;charset=utf-8"
        });
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
        saveBlob(blob, "chatgpt-export-performance-" + timestamp + ".json");
    }

    async function startExport() {
        // Reopening an active export must stay synchronous for the click handler.
        if (state.controller) {
            showPanel();
            return;
        }
        // Greasemonkey 4+ restores settings asynchronously. Do not start a
        // new request using defaults until saved preferences are loaded.
        await settingsReady;
        if (state.controller) {
            // Reopen the existing progress view; do not start another fetch
            // or overwrite the latest progress status.
            showPanel();
            return;
        }

        // First establish the new operation state, then render the panel.
        // Showing the old completed panel before setting state.controller
        // could briefly expose stale (greyed-out) controls on re-export.
        let current;
        try {
            current = parseConversationUrl(currentUrl());
        } catch (error) {
            showPanel();
            report("No original ChatGPT conversation is open.", error.message);
            return;
        }

        // SPA navigation: a new chat gets a distinct in-memory session.
        if (!state.session ||
            state.session.conversationId !== current.conversationId ||
            state.sessionMode !== selectedConfigurationKey()) {
            const profiler = createExportProfiler();
            state.profiler = profiler;
            const mode = { numTurns: state.numTurns, delay: state.delay };
            state.sessionMode = selectedConfigurationKey();
            state.session = createExportSession({
                sourceUrl: current.sourceUrl,
                numTurns: mode.numTurns,
                requestDelayMs: mode.delay,
                fetchImpl: profiler.instrumentFetch(
                    (...args) => fetch(...args),
                    () => state.session?.snapshot().pages + 1 || 1
                )
            });
        }

        hideModePanel();
        const session = state.session;
        state.controller = new AbortController();
        state.exportSettled = false;
        updateLauncherActivity();
        const signal = state.controller.signal;
        updatePanelActions(showPanel());
        const runStarted = state.profiler.runStarted();

        try {
            const initial = session.snapshot();
            report(
                initial.pages ? "Resuming export ..." : "Starting export ...",
                initial.pages + " API pages already saved"
            );

            const output = await session.run({
                signal,
                checkContext: id => {
                    if (parseConversationUrl(currentUrl()).conversationId !== id) {
                        throw new Error(
                            "Conversation changed during export. " +
                            "Return to the previous conversation to resume."
                        );
                    }
                },
                onProgress: info => {
                    state.profiler.trackPage(info);
                    report(
                        "Fetching conversation ...",
                        info.pages + " API pages, " + info.records +
                        " message records"
                    );
                }
            });

            if (!output.local_export_audit.pagination_verified) {
                throw new Error("Pagination end was not verified.");
            }

            const result = await download(output, signal);
            state.profiler.noteDownload(result);
            // The same active-time basis as summary.active_run_ms, including
            // previous resumed runs but excluding time spent paused.
            const activeDuration = formatDuration(
                state.profiler.activeElapsedMs(runStarted)
            );
            const jsonSizeMiB = (result.json_bytes / 1048576).toFixed(2);
            const downloadedSize = result.format.toUpperCase() +
                " " + result.sizeMiB + " MiB";
            report(
                "Export complete – " + result.format.toUpperCase() +
                    " download started.",
                output.local_export_audit.pages_loaded + " API pages, " +
                output.local_export_audit.unique_records + " unique message records; " +
                "Duration: " + activeDuration + " (active); " +
                "JSON uncompressed: " + jsonSizeMiB + " MiB; " +
                downloadedSize + " – " + result.fileName +
                (result.attachments ?
                    " | Attachments: " + result.attachments.downloaded +
                    "/" + result.attachments.discovered + " downloaded" : "") +
                (result.warning ? " | " + result.warning : "")
            );
        } catch (error) {
            const interrupted = signal.aborted || error.name === "AbortError";
            report(
                interrupted ? "Export cancelled; you can resume." :
                    "Export interrupted; click Export again to resume.",
                error.message + " | " +
                session.snapshot().pages + " API pages retained in this tab"
            );
        } finally {
            state.profiler.runEnded(runStarted);
            state.controller = null;
            updateLauncherActivity();
            state.exportSettled = true;
            updateSettingsInputs();
            if (state.panel?.root?.isConnected) {
                updatePanelActions(state.panel);
            }
        }
    }

    // Tampermonkey: GM_registerMenuCommand; Greasemonkey 4+: GM.registerMenuCommand.
    // Some managers only expose one of these APIs.
    const menuLabel = "Export current chat as JSON";
    try {
        if (typeof GM_registerMenuCommand === "function") {
            GM_registerMenuCommand(menuLabel, () => { void startExport(); });
        } else if (typeof GM !== "undefined" &&
                   typeof GM.registerMenuCommand === "function") {
            GM.registerMenuCommand(menuLabel, () => { void startExport(); });
        } else {
            console.info(
                "[ChatGPT Conversation Exporter] Menu API unavailable; " +
                "use the in-page Export button."
            );
        }
    } catch (error) {
        console.warn(
            "[ChatGPT Conversation Exporter] Menu registration failed; " +
            "the in-page Export button remains available.", error
        );
    }

    // Visible, intentionally small fallback for Firefox/Tampermonkey.
    // It only starts exporting after a real user click; never on page load.
    function addLauncher() {
        if (!document.body ||
            document.getElementById("chatgpt-conversation-export-launcher")) {
            return;
        }
        // A shared flex toolbar keeps the gear immediately to the right.
        const toolbar = document.createElement("div");
        toolbar.id = "chatgpt-conversation-export-toolbar";
        Object.assign(toolbar.style, {
            position: "fixed", bottom: "18px", right: "18px",
            zIndex: "2147483646", display: "inline-flex",
            alignItems: "center", gap: "5px",
            // Prefer the live ChatGPT text token; inherit computed text
            // color from the page when either token is unavailable.
            color: "var(--text-primary, var(--token-text-primary, inherit))"
        });
        const button = document.createElement("button");
        button.id = "chatgpt-conversation-export-launcher";
        button.type = "button";
        button.textContent = "Export chat as JSON";
        button.title = "Export the currently open original conversation as JSON";
        button.setAttribute("aria-label", button.title);
        button.setAttribute("aria-busy", "false");
        Object.assign(button.style, {
            padding: "6px 9px",
            border: "1px solid #8c99a8",
            borderRadius: "8px",
            color: "#fff",
            background: "#253144",
            boxShadow: "0 3px 12px rgba(0,0,0,.25)",
            cursor: "pointer",
            font: "11px/1.3 system-ui, sans-serif",
            display: "inline-flex",
            alignItems: "center",
            gap: "6px"
        });

        // Three staggered CSS-animated dots; no timers or external dependencies.
        if (!document.getElementById("chatgpt-conversation-export-spinner-style")) {
            const css = document.createElement("style");
            css.id = "chatgpt-conversation-export-spinner-style";
            css.textContent =
                "@keyframes chatgpt-conversation-export-dot-bounce {" +
                "0%, 65%, 100% { transform: translateY(0); opacity: .4; }" +
                "30% { transform: translateY(-4px); opacity: 1; }" +
                "}" +
                "@media (prefers-reduced-motion: reduce) {" +
                "#chatgpt-conversation-export-spinner > span {" +
                "animation: none !important; transform: none !important; " +
                "opacity: 1 !important; }}";
            (document.head || document.body).appendChild(css);
        }

        const spinner = document.createElement("span");
        spinner.id = "chatgpt-conversation-export-spinner";
        spinner.setAttribute("aria-hidden", "true");
        Object.assign(spinner.style, {
            display: "none",
            width: "18px",
            height: "12px",
            alignItems: "center",
            gap: "3px",
            flexShrink: "0"
        });
        for (let index = 0; index < 3; index++) {
            const dot = document.createElement("span");
            Object.assign(dot.style, {
                display: "inline-block",
                width: "4px",
                height: "4px",
                borderRadius: "50%",
                background: "currentColor",
                animation: "chatgpt-conversation-export-dot-bounce 900ms ease-in-out infinite",
                animationDelay: index * 150 + "ms"
            });
            spinner.appendChild(dot);
        }
        button.appendChild(spinner);
        state.launcher = button;
        state.launcherSpinner = spinner;
        updateLauncherActivity();
        button.addEventListener("click", () => { void startExport(); });
        toolbar.appendChild(button);

        // The native button preserves keyboard/a11y semantics, but has
        // no visual button chrome. A custom monochrome SVG avoids the
        // platform-dependent Unicode glyph (often rendered as a ship wheel).
        const settings = document.createElement("button");
        settings.id = "chatgpt-conversation-export-mode-button";
        settings.type = "button";
        settings.title = "Export performance settings";
        settings.setAttribute("aria-label", settings.title);
        Object.assign(settings.style, {
            display: "inline-flex", alignItems: "center",
            justifyContent: "center", width: "27px", height: "27px",
            padding: "0", border: "0", borderRadius: "0",
            background: "transparent", color: "inherit",
            boxShadow: "none", appearance: "none",
            cursor: "pointer", opacity: "0.85"
        });
        const svgNS = "http://www.w3.org/2000/svg";
        const gear = document.createElementNS(svgNS, "svg");
        gear.setAttribute("viewBox", "0 0 24 24");
        gear.setAttribute("width", "19");
        gear.setAttribute("height", "19");
        gear.setAttribute("fill", "currentColor");
        gear.setAttribute("aria-hidden", "true");
        gear.setAttribute("focusable", "false");
        gear.style.display = "block";
        const gearShape = document.createElementNS(svgNS, "path");
        gearShape.setAttribute("fill-rule", "evenodd");
        // Original 8-tooth gear geometry with a cut-out hub; no spokes.
        gearShape.setAttribute("d",
            "M 8.98 4.70 L 10.20 4.31 L 9.67 2.07 L 14.33 2.07 " +
            "L 13.80 4.31 L 15.02 4.70 L 16.17 5.29 L 17.38 3.33 " +
            "L 20.67 6.62 L 18.71 7.83 L 19.30 8.98 L 19.69 10.20 " +
            "L 21.93 9.67 L 21.93 14.33 L 19.69 13.80 L 19.30 15.02 " +
            "L 18.71 16.17 L 20.67 17.38 L 17.38 20.67 L 16.17 18.71 " +
            "L 15.02 19.30 L 13.80 19.69 L 14.33 21.93 L 9.67 21.93 " +
            "L 10.20 19.69 L 8.98 19.30 L 7.83 18.71 L 6.62 20.67 " +
            "L 3.33 17.38 L 5.29 16.17 L 4.70 15.02 L 4.31 13.80 " +
            "L 2.07 14.33 L 2.07 9.67 L 4.31 10.20 L 4.70 8.98 " +
            "L 5.29 7.83 L 3.33 6.62 L 6.62 3.33 L 7.83 5.29 Z " +
            "M 15 12 A 3 3 0 1 0 9 12 A 3 3 0 1 0 15 12 Z"
        );
        gear.appendChild(gearShape);
        settings.appendChild(gear);
        if (!document.getElementById("chatgpt-conversation-export-gear-style")) {
            const style = document.createElement("style");
            style.id = "chatgpt-conversation-export-gear-style";
            style.textContent =
                "#chatgpt-conversation-export-mode-button:hover {opacity: 1 !important;}" +
                "#chatgpt-conversation-export-mode-button:focus-visible {" +
                "outline: 2px solid currentColor; outline-offset: 2px; border-radius: 4px;}";
            (document.head || document.body).appendChild(style);
        }
        settings.addEventListener("click", toggleModePanel);
        toolbar.appendChild(settings);
        document.body.appendChild(toolbar);
    }

    if (typeof document !== "undefined") {
        if (document.body) {
            addLauncher();
        } else {
            document.addEventListener("DOMContentLoaded", addLauncher, {
                once: true
            });
        }
    }
})();
