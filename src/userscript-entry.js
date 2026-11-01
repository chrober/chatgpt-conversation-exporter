"use strict";

// Greasemonkey/Tampermonkey UI adapter. Core embedded by build-userscript.js.
// Do not run an export automatically when ChatGPT loads.
(function installExportCommand() {
    const state = {
        session: null,
        controller: null,
        panel: null
    };

    function currentUrl() {
        return window.location.origin + window.location.pathname;
    }

    function showPanel() {
        if (state.panel?.root?.isConnected) return state.panel;
        const root = document.createElement("aside");
        root.setAttribute("role", "region");
        root.setAttribute("aria-label", "ChatGPT JSON-Export");
        Object.assign(root.style, {
            position: "fixed",
            bottom: "18px",
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
        status.textContent = "Bereit.";
        root.appendChild(status);

        const progress = document.createElement("div");
        progress.style.marginTop = "8px";
        progress.style.color = "#c4cedb";
        root.appendChild(progress);

        const actions = document.createElement("div");
        actions.style.marginTop = "12px";
        actions.style.display = "flex";
        actions.style.gap = "8px";

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

        const cancel = makeButton("Abbrechen", () => {
            state.controller?.abort();
        });
        makeButton("Schließen", () => {
            root.remove();
            state.panel = null;
        });
        cancel.disabled = true;
        root.appendChild(actions);
        document.body.appendChild(root);
        state.panel = { root, status, progress, cancel };
        return state.panel;
    }

    function report(message, detail = "") {
        const panel = showPanel();
        panel.status.textContent = message;
        panel.progress.textContent = detail;
        console.info("[ChatGPT Conversation Exporter]", message, detail);
    }

    function download(data) {
        const json = JSON.stringify(data, null, 2);
        const blob = new Blob([json], {
            type: "application/json;charset=utf-8"
        });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        const fileName = "chatgpt-conversation-" + data.conversation_id + ".json";
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        // Keep the blob alive long enough for the download to begin.
        setTimeout(() => URL.revokeObjectURL(url), 60000);
        return { fileName, sizeMiB: (blob.size / 1048576).toFixed(2) };
    }

    async function startExport() {
        if (state.controller) {
            report("Ein Export läuft bereits.");
            return;
        }

        let current;
        try {
            current = parseConversationUrl(currentUrl());
        } catch (error) {
            report("Kein Original-Chat geöffnet.", error.message);
            return;
        }

        // SPA navigation: a new chat gets a distinct in-memory session.
        if (!state.session ||
            state.session.conversationId !== current.conversationId) {
            state.session = createExportSession({
                sourceUrl: current.sourceUrl,
                fetchImpl: (...args) => fetch(...args)
            });
        }

        const session = state.session;
        state.controller = new AbortController();
        const signal = state.controller.signal;
        showPanel().cancel.disabled = false;

        try {
            const initial = session.snapshot();
            report(
                initial.pages ? "Setze Export fort ..." : "Starte Export ...",
                initial.pages + " gespeicherte Seiten"
            );

            const output = await session.run({
                signal,
                checkContext: id => {
                    if (parseConversationUrl(currentUrl()).conversationId !== id) {
                        throw new Error(
                            "Chat während des Exports gewechselt. " +
                            "Zum vorherigen Chat zurückkehren und erneut starten."
                        );
                    }
                },
                onProgress: info => {
                    report(
                        "Lade Nachrichten ...",
                        info.pages + " Seiten, " + info.records +
                        " Datensätze; weitere ältere Seiten werden geprüft"
                    );
                }
            });

            if (!output.local_export_audit.pagination_verified) {
                throw new Error("Ende der Paginierung nicht bestätigt.");
            }

            const result = download(output);
            report(
                "Export abgeschlossen – Download gestartet.",
                output.local_export_audit.pages_loaded + " Seiten, " +
                output.local_export_audit.unique_records + " eindeutige Datensätze; " +
                result.sizeMiB + " MiB – " + result.fileName
            );
        } catch (error) {
            const interrupted = signal.aborted || error.name === "AbortError";
            report(
                interrupted ? "Export abgebrochen; später fortsetzbar." :
                    "Export unterbrochen; erneut über Greasemonkey starten.",
                error.message + " | " +
                session.snapshot().pages + " Seiten im aktuellen Tab gespeichert"
            );
        } finally {
            state.controller = null;
            if (state.panel) state.panel.cancel.disabled = true;
        }
    }

    // Tampermonkey: GM_registerMenuCommand; Greasemonkey 4+: GM.registerMenuCommand.
    // Some managers only expose one of these APIs.
    const menuLabel = "Aktuellen Chat als JSON exportieren";
    try {
        if (typeof GM_registerMenuCommand === "function") {
            GM_registerMenuCommand(menuLabel, () => { void startExport(); });
        } else if (typeof GM !== "undefined" &&
                   typeof GM.registerMenuCommand === "function") {
            GM.registerMenuCommand(menuLabel, () => { void startExport(); });
        } else {
            console.info(
                "[ChatGPT Conversation Exporter] Kein Userscript-Menü verfügbar; " +
                "der Export-Button auf der Seite bleibt verwendbar."
            );
        }
    } catch (error) {
        console.warn(
            "[ChatGPT Conversation Exporter] Menüregistrierung fehlgeschlagen; " +
            "Export-Button bleibt verwendbar.", error
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
        button.textContent = "Chat als JSON exportieren";
        button.title = "Aktuell geöffneten Original-Chat als JSON exportieren";
        button.setAttribute("aria-label", button.title);
        Object.assign(button.style, {
            position: "fixed",
            bottom: "18px",
            left: "18px",
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
