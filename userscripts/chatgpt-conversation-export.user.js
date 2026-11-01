// ==UserScript==
// @name         ChatGPT Conversation Exporter
// @namespace    https://github.com/chrober/chatgpt-conversation-exporter
// @version      0.1.5
// @author       Christoph O'Bermair
// @description  Export the current ChatGPT conversation as JSON.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
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
        throw new Error("The exporter only works on https://chatgpt.com.");
    }
    const match = url.pathname.match(CONVERSATION_PATH);
    if (!match) {
        throw new Error("Open an original conversation (/c/<ID>), not a shared link.");
    }
    return {
        conversationId: match[1].toLowerCase(),
        sourceUrl: url.origin + url.pathname
    };
}

function abortError() {
    const error = new Error("Export cancelled.");
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
        throw new Error("Invalid or empty API page; partial export refused.");
    }
    if (!page.page_info ||
        typeof page.page_info.has_previous_page !== "boolean") {
        throw new Error("Pagination information is missing; partial export refused.");
    }
    if (page.page_info.has_previous_page && !page.page_info.start_cursor) {
        throw new Error("Missing start cursor; partial export refused.");
    }
    if (page.messages.some(item => !item || typeof item.id !== "string" || !item.id)) {
        throw new Error("Message record has no valid ID; partial export refused.");
    }
    return page.page_info;
}

function assembleExport(pages, conversationId, sourceUrl) {
    if (!pages.length || pages.at(-1).page_info?.has_previous_page !== false) {
        throw new Error("Pagination end not confirmed; download refused.");
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
                    throw new Error("Conflicting message ID: " + message.id);
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
        throw new Error("fetchImpl is required.");
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
            throw new Error("Session unavailable: HTTP " + response.status);
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
                    const error = new Error("Message request: HTTP " + response.status);
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
        if (running) throw new Error("Export already running.");
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
                    throw new Error("Maximum API page limit reached; partial export refused.");
                }
                const page = await requestPage(headers, nextCursor, signal);
                const info = validatePage(page);
                if (checkContext) checkContext(conversationId);
                assertNotAborted(signal);

                if (info.start_cursor && seenCursors.has(info.start_cursor)) {
                    throw new Error("Repeated page cursor; partial export refused.");
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

/**
 * Local-only, content-free performance profiling.
 * No chat identifiers, URLs, cursors, tokens, headers or message bodies.
 * The report is saved only after an explicit user action.
 */
function createExportProfiler(options = {}) {
    const now = options.now ?? (() =>
        typeof performance !== "undefined" ? performance.now() : Date.now()
    );
    const requests = [];
    const pages = [];
    const startedAt = new Date().toISOString();
    let lastRecords = 0;
    let activeRunMs = 0;
    let serializationMs = null;
    let jsonBytes = null;
    let completed = false;

    const ms = value => Math.max(0, Math.round(value * 10) / 10);
    const total = (items, key) => ms(
        items.reduce((acc, item) => acc + (item[key] || 0), 0)
    );

    function instrumentFetch(fetchImpl, getPageNumber) {
        return async (url, options) => {
            const isAuth = url === "/api/auth/session";
            const apiPage = isAuth ? 0 : getPageNumber();
            const attempt = isAuth ? 1 :
                requests.filter(item =>
                    item.kind === "messages" && item.api_page === apiPage
                ).length + 1;
            const started = now();
            const item = {
                kind: isAuth ? "session" : "messages",
                api_page: apiPage,
                attempt,
                status: null,
                outcome: null,
                fetch_ms: null,
                parse_ms: 0,
                reported_content_length_bytes: null
            };
            try {
                const response = await fetchImpl(url, options);
                item.fetch_ms = ms(now() - started);
                item.status = Number.isInteger(response.status) ?
                    response.status : null;
                const length = Number(response.headers?.get("content-length"));
                if (Number.isSafeInteger(length) && length > 0) {
                    item.reported_content_length_bytes = length;
                }
                item.outcome = response.ok ? "ok" : "http_error";
                requests.push(item);
                // The core reads response.json only on success.
                if (!response.ok) return response;

                return {
                    ok: true,
                    status: response.status,
                    json: async () => {
                        const parseStarted = now();
                        try {
                            return await response.json();
                        } finally {
                            item.parse_ms = ms(now() - parseStarted);
                        }
                    }
                };
            } catch (error) {
                // This includes aborted or otherwise failed fetches.
                item.fetch_ms = ms(now() - started);
                item.outcome = "network_error";
                requests.push(item);
                throw error;
            }
        };
    }

    function trackPage(snapshot) {
        const pageNumber = snapshot.pages;
        if (pages.some(item => item.api_page === pageNumber)) return;
        const attempts = requests.filter(item =>
            item.kind === "messages" && item.api_page === pageNumber
        );
        const records = snapshot.records - lastRecords;
        pages.push({
            api_page: pageNumber,
            message_records: records,
            cumulative_records: snapshot.records,
            http_attempts: attempts.length,
            fetch_ms: total(attempts, "fetch_ms"),
            json_parse_ms: total(attempts, "parse_ms")
        });
        lastRecords = snapshot.records;
    }

    function runStarted() { return now(); }
    function runEnded(started) {
        activeRunMs += ms(now() - started);
    }
    function noteDownload(metrics) {
        serializationMs = ms(metrics.serialization_ms);
        jsonBytes = metrics.json_bytes;
        completed = true;
    }
    function hasSamples() { return requests.length > 0 || pages.length > 0; }

    function report() {
        const fetchTimes = requests.filter(item =>
            item.kind === "messages"
        ).map(item => item.fetch_ms).sort((a, b) => a - b);
        const percentile = fraction => fetchTimes.length ?
            fetchTimes[Math.ceil(fetchTimes.length * fraction) - 1] : null;
        const messageRequests = requests.filter(item =>
            item.kind === "messages"
        );
        const sumFetch = total(requests, "fetch_ms");
        const sumParse = total(requests, "parse_ms");
        const httpStatusCounts = {};
        for (const request of messageRequests) {
            const code = request.status === null ? "network_error" :
                String(request.status);
            httpStatusCounts[code] = (httpStatusCounts[code] ?? 0) + 1;
        }
        const recordCount = pages.at(-1)?.cumulative_records ?? 0;
        return {
            profile_format: "chatgpt-export-performance-v1",
            userscript_version: "0.1.5",
            created_at: startedAt,
            reported_at: new Date().toISOString(),
            completed,
            privacy: "No conversation URLs/IDs, cursors, tokens, headers, message IDs or content",
            measurement_notes: [
                "API page = one paginated backend response, not a browser page or a single message.",
                "fetch_ms is client-side time until HTTP response headers, not full request processing.",
                "parse_ms includes response body reading and JSON parsing.",
                "HTTP Content-Length may refer to compressed transfer data and may be absent.",
                "active_run_ms includes network, throttling, retries and processing, but excludes pauses between resumed runs.",
                "Only completed API pages appear under pages. Failed attempts remain under requests."
            ],
            summary: {
                api_pages_completed: pages.length,
                message_records: recordCount,
                message_http_attempts: messageRequests.length,
                retries: messageRequests.filter(item => item.attempt > 1).length,
                request_status_counts: httpStatusCounts,
                network_header_wait_ms: sumFetch,
                response_json_parse_ms: sumParse,
                active_run_ms: ms(activeRunMs),
                json_serialization_ms: serializationMs,
                exported_json_bytes: jsonBytes,
                fetch_p50_ms: percentile(0.50),
                fetch_p95_ms: percentile(0.95),
                records_per_active_second: activeRunMs > 0 ?
                    ms(recordCount * 1000 / activeRunMs) : null
            },
            pages: pages.map(item => ({ ...item })),
            requests: requests.map(item => ({ ...item }))
        };
    }

    return {
        instrumentFetch, trackPage, runStarted, runEnded,
        noteDownload, hasSamples, report
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { createExportProfiler };
}

"use strict";

// Greasemonkey/Tampermonkey UI adapter. Core embedded by build-userscript.js.
// Do not run an export automatically when ChatGPT loads.
(function installExportCommand() {
    const state = {
        session: null,
        controller: null,
        panel: null,
        profiler: null,
        statusText: "Ready.",
        detailText: ""
    };

    function currentUrl() {
        return window.location.origin + window.location.pathname;
    }

    // The button already used the native disabled attribute; style it too so
    // the completed (or cancelled) state is visually unmistakable.
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
            if (state.profiler?.hasSamples()) {
                downloadProfile(state.profiler.report());
                report("Performance report downloaded.", "The report excludes chat content and identifiers.");
            }
        });
        makeButton("Close", () => {
            root.remove();
            state.panel = null;
        });
        setCancelEnabled(cancel, Boolean(state.controller &&
            !state.controller.signal.aborted));
        saveProfile.disabled = !state.profiler?.hasSamples();
        root.appendChild(actions);
        document.body.appendChild(root);
        state.panel = { root, status, progress, cancel, saveProfile };
        return state.panel;
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
            panel.saveProfile.disabled = !state.profiler?.hasSamples();
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
            // Reopen the existing progress view; do not start another fetch
            // or overwrite the latest progress status.
            showPanel();
            return;
        }

        // All panel openings require an explicit user action.
        showPanel();
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
        setCancelEnabled(showPanel().cancel, true);
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
            if (state.panel) setCancelEnabled(state.panel.cancel, false);
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

})();
