// ==UserScript==
// @name         ChatGPT Conversation Exporter
// @namespace    https://github.com/chrober/chatgpt-conversation-exporter
// @version      0.1.0
// @description  Exportiert den aktuell geöffneten Original-Chat als JSON.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM.registerMenuCommand
// ==/UserScript==

(function () {

"use strict";

/**
 * ChatGPT conversation exporter, deliberately independent of Greasemonkey and DOM.
 * The backend endpoints are undocumented; the response shape may change.
 */
const TEMPORARY_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CONVERSATION_PATH = new RegExp("/c/(" + UUID + ")(?:/|$)", "i");

function parseConversationUrl(value) {
    const url = new URL(value);
    if (url.origin !== "https://chatgpt.com") {
        throw new Error("Der Export funktioniert nur auf https://chatgpt.com.");
    }
    const match = url.pathname.match(CONVERSATION_PATH);
    if (!match) {
        throw new Error("Bitte einen Original-Chat (/c/<ID>) öffnen, keinen Share-Link.");
    }
    return {
        conversationId: match[1].toLowerCase(),
        sourceUrl: url.origin + url.pathname
    };
}

function abortError() {
    const error = new Error("Export abgebrochen.");
    error.name = "AbortError";
    return error;
}

function assertNotAborted(signal) {
    if (signal?.aborted) throw abortError();
}

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(abortError());
        let timer;
        const onAbort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
            reject(abortError());
        };
        timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
        }, ms);
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}

function validatePage(page) {
    if (!page || !Array.isArray(page.messages) || page.messages.length === 0) {
        throw new Error("Ungültige oder leere Nachrichtenseite; kein Teil-Export.");
    }
    if (!page.page_info ||
        typeof page.page_info.has_previous_page !== "boolean") {
        throw new Error("Paginierungsstatus fehlt; kein Teil-Export.");
    }
    if (page.page_info.has_previous_page && !page.page_info.start_cursor) {
        throw new Error("Start-Cursor fehlt; kein Teil-Export.");
    }
    if (page.messages.some(item => !item || typeof item.id !== "string" || !item.id)) {
        throw new Error("Nachricht ohne eindeutige ID; kein Teil-Export.");
    }
    return page.page_info;
}

function assembleExport(pages, conversationId, sourceUrl) {
    if (!pages.length || pages.at(-1).page_info?.has_previous_page !== false) {
        throw new Error("Paginierungsende nicht bestätigt; kein Download.");
    }

    const messages = [];
    const seen = new Map();
    let rawRecords = 0;
    let duplicates = 0;

    // API page order is newest first; preserve original order within each page.
    for (const page of [...pages].reverse()) {
        for (const message of page.messages) {
            rawRecords++;
            const previous = seen.get(message.id);
            if (previous) {
                duplicates++;
                if (JSON.stringify(previous) !== JSON.stringify(message)) {
                    throw new Error("Widersprüchliche Nachrichten-ID: " + message.id);
                }
                continue;
            }
            seen.set(message.id, message);
            messages.push(message);
        }
    }

    const pageMetadata = pages.map((page, index) => {
        const { messages: originalMessages, ...metadata } = page;
        return {
            page_number: index + 1,
            message_count: originalMessages.length,
            first_message_id: originalMessages[0]?.id ?? null,
            last_message_id: originalMessages.at(-1)?.id ?? null,
            ...metadata
        };
    });

    return {
        export_format: "chatgpt-paginated-conversation-v2",
        source_url: sourceUrl,
        conversation_id: conversationId,
        messages,
        page_metadata: pageMetadata,
        local_export_audit: {
            exported_at: new Date().toISOString(),
            pages_loaded: pages.length,
            raw_records: rawRecords,
            unique_records: messages.length,
            duplicate_records: duplicates,
            pagination_verified: true,
            attachments_fetched_separately: false
        }
    };
}

/**
 * Keeps validated pages in memory after an error or user cancellation.
 * Resume by calling run() again on the same session without reloading the tab.
 */
function createExportSession(options) {
    const {
        sourceUrl: suppliedUrl,
        fetchImpl,
        sleep = wait,
        maxPages = 5000,
        maxAttempts = 4,
        requestDelayMs = 250
    } = options;

    if (typeof fetchImpl !== "function") {
        throw new Error("fetchImpl fehlt.");
    }

    const { conversationId, sourceUrl } = parseConversationUrl(suppliedUrl);
    const pages = [];
    let nextCursor = null;
    let completed = false;
    let running = false;

    function snapshot() {
        return {
            conversationId,
            sourceUrl,
            pages: pages.length,
            records: pages.reduce((sum, page) => sum + page.messages.length, 0),
            completed,
            running
        };
    }

    async function sessionHeaders(signal) {
        const response = await fetchImpl("/api/auth/session", {
            credentials: "include",
            signal
        });
        if (!response.ok) {
            throw new Error("Sitzung nicht verfügbar: HTTP " + response.status);
        }
        const session = await response.json();
        const token = session.accessToken ?? session.access_token;
        const headers = { Accept: "application/json" };
        if (token) headers.Authorization = "Bearer " + token;
        return headers;
    }

    async function requestPage(headers, before, signal) {
        const params = new URLSearchParams({
            include_has_versions: "true",
            num_turns: "1"
        });
        if (before) params.set("before", before);

        const endpoint =
            "/backend-api/conversations/" + conversationId +
            "/messages?" + params.toString();

        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            assertNotAborted(signal);
            try {
                const response = await fetchImpl(endpoint, {
                    credentials: "include",
                    headers,
                    cache: "no-store",
                    signal
                });

                if (!response.ok) {
                    const error = new Error("Nachrichtenabruf: HTTP " + response.status);
                    error.retryable = TEMPORARY_HTTP_STATUSES.has(response.status);
                    throw error;
                }
                return await response.json();
            } catch (error) {
                if (signal?.aborted) throw abortError();
                const retryable = error.retryable === true ||
                    error instanceof TypeError;
                if (!retryable || attempt >= maxAttempts) throw error;
                await sleep(1500 * Math.pow(2, attempt - 1), signal);
            }
        }
    }

    async function run({ signal, onProgress, checkContext } = {}) {
        if (running) throw new Error("Export läuft bereits.");
        running = true;
        try {
            assertNotAborted(signal);
            if (checkContext) checkContext(conversationId);
            if (completed) return assembleExport(pages, conversationId, sourceUrl);

            const headers = await sessionHeaders(signal);
            const seenCursors = new Set(pages.map(
                page => page.page_info?.start_cursor
            ).filter(Boolean));

            while (!completed) {
                assertNotAborted(signal);
                if (checkContext) checkContext(conversationId);
                if (pages.length >= maxPages) {
                    throw new Error("Maximale Seitenzahl erreicht; kein Teil-Export.");
                }
                const page = await requestPage(headers, nextCursor, signal);
                const info = validatePage(page);
                if (checkContext) checkContext(conversationId);
                assertNotAborted(signal);

                if (info.start_cursor && seenCursors.has(info.start_cursor)) {
                    throw new Error("Wiederholter Cursor; kein Teil-Export.");
                }
                if (info.start_cursor) seenCursors.add(info.start_cursor);

                pages.push(page);
                nextCursor = info.start_cursor ?? null;
                completed = info.has_previous_page === false;

                if (onProgress) onProgress(snapshot());
                if (!completed) await sleep(requestDelayMs, signal);
            }
            return assembleExport(pages, conversationId, sourceUrl);
        } finally {
            running = false;
        }
    }

    return { conversationId, sourceUrl, snapshot, run };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        parseConversationUrl,
        validatePage,
        assembleExport,
        createExportSession
    };
}

"use strict";

// Greasemonkey UI adapter. The exporter core is embedded by build-userscript.js.
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

    if (typeof GM !== "undefined" &&
        typeof GM.registerMenuCommand === "function") {
        GM.registerMenuCommand(
            "Aktuellen Chat als JSON exportieren",
            () => { void startExport(); }
        );
    } else {
        console.warn(
            "[ChatGPT Conversation Exporter] " +
            "GM.registerMenuCommand ist nicht verfügbar."
        );
    }
})();

})();
