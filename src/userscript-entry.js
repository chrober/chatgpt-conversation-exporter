"use strict";

// Greasemonkey/Tampermonkey UI adapter. Core embedded by build-userscript.js.
// Do not run an export automatically when ChatGPT loads.
(function installExportCommand() {
    const state = {
        session: null,
        controller: null,
        panel: null,
        profiler: null
    };

    function currentUrl() {
        return window.location.origin + window.location.pathname;
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
        status.textContent = "Ready.";
        root.appendChild(status);

        const progress = document.createElement("div");
        progress.style.marginTop = "8px";
        progress.style.color = "#c4cedb";
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
            if (state.profiler?.hasSamples()) {
                downloadProfile(state.profiler.report());
                report("Performance report downloaded.", "The report excludes chat content and identifiers.");
            }
        });
        makeButton("Close", () => {
            root.remove();
            state.panel = null;
        });
        cancel.disabled = true;
        saveProfile.disabled = !state.profiler?.hasSamples();
        root.appendChild(actions);
        document.body.appendChild(root);
        state.panel = { root, status, progress, cancel, saveProfile };
        return state.panel;
    }

    function report(message, detail = "") {
        const panel = showPanel();
        panel.status.textContent = message;
        panel.progress.textContent = detail;
        panel.saveProfile.disabled = !state.profiler?.hasSamples();
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

    function download(data) {
        const started = performance.now();
        const json = JSON.stringify(data, null, 2);
        const serializationMs = Math.round((performance.now() - started) * 10) / 10;
        const blob = new Blob([json], {
            type: "application/json;charset=utf-8"
        });
        const fileName = "chatgpt-conversation-" + data.conversation_id + ".json";
        saveBlob(blob, fileName);
        return {
            fileName,
            sizeMiB: (blob.size / 1048576).toFixed(2),
            json_bytes: blob.size,
            serialization_ms: serializationMs
        };
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
        if (state.controller) {
            report("An export is already running.");
            return;
        }

        let current;
        try {
            current = parseConversationUrl(currentUrl());
        } catch (error) {
            report("No original ChatGPT conversation is open.", error.message);
            return;
        }

        // SPA navigation: a new chat gets a distinct in-memory session.
        if (!state.session ||
            state.session.conversationId !== current.conversationId) {
            const profiler = createExportProfiler();
            state.profiler = profiler;
            state.session = createExportSession({
                sourceUrl: current.sourceUrl,
                fetchImpl: profiler.instrumentFetch(
                    (...args) => fetch(...args),
                    () => state.session?.snapshot().pages + 1 || 1
                )
            });
        }

        const session = state.session;
        state.controller = new AbortController();
        const signal = state.controller.signal;
        showPanel().cancel.disabled = false;
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
                        " message records; checking for older pages"
                    );
                }
            });

            if (!output.local_export_audit.pagination_verified) {
                throw new Error("Pagination end was not verified.");
            }

            const result = download(output);
            state.profiler.noteDownload(result);
            report(
                "Export complete – JSON download started.",
                output.local_export_audit.pages_loaded + " API pages, " +
                output.local_export_audit.unique_records + " unique message records; " +
                result.sizeMiB + " MiB – " + result.fileName
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
            if (state.panel) state.panel.cancel.disabled = true;
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
        const button = document.createElement("button");
        button.id = "chatgpt-conversation-export-launcher";
        button.type = "button";
        button.textContent = "Export chat as JSON";
        button.title = "Export the currently open original conversation as JSON";
        button.setAttribute("aria-label", button.title);
        Object.assign(button.style, {
            position: "fixed",
            bottom: "18px",
            right: "18px",
            zIndex: "2147483646",
            padding: "8px 12px",
            border: "1px solid #8c99a8",
            borderRadius: "8px",
            color: "#fff",
            background: "#253144",
            boxShadow: "0 3px 12px rgba(0,0,0,.25)",
            cursor: "pointer",
            font: "12px/1.3 system-ui, sans-serif"
        });
        button.addEventListener("click", () => { void startExport(); });
        document.body.appendChild(button);
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
