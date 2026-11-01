// ==UserScript==
// @name         ChatGPT Conversation Exporter
// @namespace    https://github.com/chrober/chatgpt-conversation-exporter
// @version      0.2.0
// @author       Christoph O'Bermair
// @description  Export the current ChatGPT conversation as JSON.
// @match        https://chatgpt.com/*
// @run-at       document-idle
// @grant        GM_registerMenuCommand
// @grant        GM.registerMenuCommand
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM.getValue
// @grant        GM.setValue
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
        requestDelayMs = 250,
        numTurns = 1,
        fallbackAfterErrors = 2
    } = options;

    if (typeof fetchImpl !== "function") {
        throw new Error("fetchImpl is required.");
    }
    // Do not artificially cap batching at the previously tested 3 turns.
    // A generous safety bound guards against accidental multi-million-turn
    // requests; actual backend limits are enforced by existing retry logic.
    if (!Number.isInteger(numTurns) || numTurns < 1 || numTurns > 1000) {
        throw new RangeError("numTurns must be an integer between 1 and 1000.");
    }
    if (!Number.isInteger(requestDelayMs) ||
        requestDelayMs < 0 || requestDelayMs > 60000) {
        throw new RangeError("requestDelayMs must be an integer between 0 and 60000.");
    }

    const { conversationId, sourceUrl } = parseConversationUrl(suppliedUrl);
    const pages = [];
    let nextCursor = null;
    let completed = false;
    let running = false;
    // The larger batch is experimental. If it repeatedly times out, switch
    // to the proven 1-turn mode for the remaining pages and any resume.
    let effectiveNumTurns = numTurns;
    let fallbackCount = 0;

    function snapshot() {
        return {
            conversationId,
            sourceUrl,
            pages: pages.length,
            records: pages.reduce((sum, page) => sum + page.messages.length, 0),
            completed,
            running,
            effectiveNumTurns,
            fallbackCount,
            requestDelayMs
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
        let consecutiveBatchErrors = 0;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            assertNotAborted(signal);
            const params = new URLSearchParams({
                include_has_versions: "true",
                num_turns: String(effectiveNumTurns)
            });
            if (before) params.set("before", before);
            const endpoint =
                "/backend-api/conversations/" + conversationId +
                "/messages?" + params.toString();

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
                    // 429 is rate limiting, not evidence of an oversized batch.
                    error.batchFailure = [500, 502, 503, 504].includes(response.status);
                    throw error;
                }
                return await response.json();
            } catch (error) {
                if (signal?.aborted) throw abortError();
                const retryable = error.retryable === true ||
                    error instanceof TypeError;
                if (!retryable || attempt >= maxAttempts) throw error;

                if (effectiveNumTurns > 1 &&
                    (error.batchFailure || error instanceof TypeError)) {
                    consecutiveBatchErrors++;
                    if (consecutiveBatchErrors >= fallbackAfterErrors) {
                        effectiveNumTurns = 1;
                        fallbackCount++;
                    }
                }
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
    let archiveBytes = null;
    let compressionMs = null;
    let downloadFormat = null;
    let completed = false;

    const ms = value => Math.max(0, Math.round(value * 10) / 10);
    const total = (items, key) => ms(
        items.reduce((acc, item) => acc + (item[key] || 0), 0)
    );

    function instrumentFetch(fetchImpl, getPageNumber) {
        return async (url, options) => {
            const isAuth = url === "/api/auth/session";
            // Only record public tuning parameters; never retain the URL,
            // conversation ID or the secret pagination cursor.
            const turnsMatch = isAuth ? null : /(?:[?&])num_turns=(\d+)/.exec(url);
            const numTurns = turnsMatch ? Number(turnsMatch[1]) : null;
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
                num_turns: numTurns,
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
            json_parse_ms: total(attempts, "parse_ms"),
            num_turns: attempts.at(-1)?.num_turns ?? null,
            request_delay_ms: snapshot.requestDelayMs ?? null
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
        archiveBytes = metrics.archive_bytes ?? metrics.json_bytes;
        compressionMs = metrics.compression_ms === undefined ?
            null : ms(metrics.compression_ms);
        downloadFormat = metrics.format ?? "json";
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
            userscript_version: "0.2.0",
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
                "Only completed API pages appear under pages. Failed attempts remain under requests.",
                "num_turns records the numeric request batch setting; larger batches automatically fall back to 1 after repeated transient backend failures.",
                "ZIP compression uses browser-native DEFLATE; archive_bytes measures the local ZIP output, not the original JSON size."
            ],
            summary: {
                api_pages_completed: pages.length,
                message_records: recordCount,
                message_http_attempts: messageRequests.length,
                requests_by_num_turns: messageRequests.reduce((counts, item) => {
                    const key = String(item.num_turns ?? "unknown");
                    counts[key] = (counts[key] || 0) + 1;
                    return counts;
                }, {}),
                request_delay_ms: pages.at(-1)?.request_delay_ms ?? null,
                retries: messageRequests.filter(item => item.attempt > 1).length,
                request_status_counts: httpStatusCounts,
                network_header_wait_ms: sumFetch,
                response_json_parse_ms: sumParse,
                active_run_ms: ms(activeRunMs),
                json_serialization_ms: serializationMs,
                zip_compression_ms: compressionMs,
                download_format: downloadFormat,
                exported_json_bytes: jsonBytes,
                archive_bytes: archiveBytes,
                compression_ratio: jsonBytes && archiveBytes !== null ?
                    ms(archiveBytes / jsonBytes) : null,
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

/**
 * Create a standard, single-file ZIP archive (DEFLATE method 8) using the
 * browser-native Compression Streams API. No third-party code or downloads.
 * For browsers without deflate-raw support, callers retain the original JSON.
 * The ZIP 32-bit size limits are enforced; no silent ZIP64 truncation.
 */
function crc32(bytes) {
    let crc = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) {
        crc ^= bytes[i];
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function encodeZipSingleFile(name, inputBytes, deflateBytes) {
    const nameBytes = new TextEncoder().encode(name);
    const MAX_U32 = 0xffffffff;
    if (!nameBytes.length || nameBytes.length > 0xffff) {
        throw new RangeError("ZIP entry name must fit in 65,535 UTF-8 bytes.");
    }
    if (inputBytes.byteLength > MAX_U32 || deflateBytes.byteLength > MAX_U32) {
        throw new RangeError("ZIP64 is not supported; entry exceeds 4 GiB.");
    }

    const compressedSize = deflateBytes.byteLength;
    const originalSize = inputBytes.byteLength;
    const checksum = crc32(inputBytes);
    const flags = 0x0800; // UTF-8 filename
    const method = 8; // Raw DEFLATE
    const dosDate = 33; // 1980-01-01
    const localSize = 30 + nameBytes.length;
    const centralSize = 46 + nameBytes.length;
    const centralOffset = localSize + compressedSize;
    if (centralOffset > MAX_U32) {
        throw new RangeError("ZIP64 is not supported; archive exceeds 4 GiB.");
    }

    const local = new Uint8Array(localSize);
    const lh = new DataView(local.buffer);
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true); // ZIP spec version 2.0 needed
    lh.setUint16(6, flags, true);
    lh.setUint16(8, method, true);
    lh.setUint16(10, 0, true); // DOS time
    lh.setUint16(12, dosDate, true);
    lh.setUint32(14, checksum, true);
    lh.setUint32(18, compressedSize, true);
    lh.setUint32(22, originalSize, true);
    lh.setUint16(26, nameBytes.length, true);
    lh.setUint16(28, 0, true); // Extra field length
    local.set(nameBytes, 30);

    const central = new Uint8Array(centralSize);
    const ch = new DataView(central.buffer);
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true); // Created by ZIP 2.0
    ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, 0, true);
    ch.setUint16(14, dosDate, true);
    ch.setUint32(16, checksum, true);
    ch.setUint32(20, compressedSize, true);
    ch.setUint32(24, originalSize, true);
    ch.setUint16(28, nameBytes.length, true);
    ch.setUint16(30, 0, true);
    ch.setUint16(32, 0, true); // File comment length
    ch.setUint16(34, 0, true); // Disk start
    ch.setUint16(36, 0, true); // Internal attributes
    ch.setUint32(38, 0, true); // External attributes
    ch.setUint32(42, 0, true); // Local header offset
    central.set(nameBytes, 46);

    const end = new Uint8Array(22);
    const eh = new DataView(end.buffer);
    eh.setUint32(0, 0x06054b50, true);
    eh.setUint16(4, 0, true);
    eh.setUint16(6, 0, true);
    eh.setUint16(8, 1, true);
    eh.setUint16(10, 1, true);
    eh.setUint32(12, centralSize, true);
    eh.setUint32(16, centralOffset, true);
    eh.setUint16(20, 0, true);

    return new Blob([local, deflateBytes, central, end], {
        type: "application/zip"
    });
}

/**
 * The caller passes serialized JSON and its intended plain filename.
 * Returns a ZIP containing that exact JSON or, on unsupported compression,
 * a lossless .json fallback (never a mislabeled .zip).
 */
async function compressJsonAsZipOrPlain(json, fileName, options = {}) {
    const now = options.now ?? (() => performance.now());
    const zipSupported = Object.prototype.hasOwnProperty.call(options, "CompressionStream") ?
        options.CompressionStream :
        (typeof CompressionStream !== "undefined" ? CompressionStream : null);
    const responseFactory = Object.prototype.hasOwnProperty.call(options, "Response") ?
        options.Response :
        (typeof Response !== "undefined" ? Response : null);
    const start = now();
    const bytes = new TextEncoder().encode(json);
    const jsonBytes = bytes.byteLength;

    try {
        if (!zipSupported || !responseFactory) {
            throw new Error("Native ZIP compression is not supported.");
        }
        const compressor = new zipSupported("deflate-raw");
        const stream = new Blob([bytes]).stream().pipeThrough(compressor);
        const compressed = new Uint8Array(
            await new responseFactory(stream).arrayBuffer()
        );
        const zip = encodeZipSingleFile(fileName, bytes, compressed);
        return {
            blob: zip,
            fileName: fileName.replace(/\.json$/i, ".zip"),
            format: "zip",
            jsonBytes,
            archiveBytes: zip.size,
            compressionMs: Math.round((now() - start) * 10) / 10,
            warning: null
        };
    } catch (error) {
        // Fallback is explicit and never silently produces a corrupt ZIP.
        const plain = new Blob([bytes], {
            type: "application/json;charset=utf-8"
        });
        return {
            blob: plain,
            fileName,
            format: "json",
            jsonBytes,
            archiveBytes: plain.size,
            compressionMs: Math.round((now() - start) * 10) / 10,
            warning: "ZIP unavailable; downloaded uncompressed JSON instead."
        };
    }
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { crc32, encodeZipSingleFile, compressJsonAsZipOrPlain };
}

"use strict";

// Greasemonkey/Tampermonkey UI adapter. Core embedded by build-userscript.js.
// Do not run an export automatically when ChatGPT loads.
(function installExportCommand() {
    const SETTINGS_KEY = "chatgpt-conversation-exporter.settings.v2";
    const LEGACY_SETTINGS_KEY = "chatgpt-conversation-exporter.settings.v1";
    const SESSION_KEY = "chatgpt-conversation-exporter.session-settings.v2";
    const DEFAULT_SETTINGS = Object.freeze({ numTurns: 3, delay: 100 });
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
        return { numTurns: raw.numTurns, delay: raw.delay };
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
        const disabled = !state.settingsLoaded || Boolean(state.controller);
        state.modeTurnInput.disabled = disabled;
        state.modeDelayInput.disabled = disabled;
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
        storeSessionSettings(settings);
    }

    function readFields() {
        const turns = state.modeTurnInput?.value?.trim();
        const delay = state.modeDelayInput?.value?.trim();
        if (!turns || !delay || !/^\d+$/.test(turns) ||
            !/^\d+$/.test(delay)) return null;
        return validateSettings({ numTurns: Number(turns), delay: Number(delay) });
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
        const settings = { numTurns: state.numTurns, delay: state.delay };
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
            }
            try {
                const rawSession = window.sessionStorage?.getItem(SESSION_KEY);
                const session = rawSession ?
                    validateSettings(JSON.parse(rawSession)) : null;
                if (session) {
                    state.numTurns = session.numTurns;
                    state.delay = session.delay;
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
        document.body.appendChild(root);
        state.modePanel = root;
        state.modeTurnInput = turns;
        state.modeDelayInput = delay;
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
        const started = performance.now();
        const json = JSON.stringify(data, null, 2);
        const serializationMs = Math.round((performance.now() - started) * 10) / 10;
        const jsonFileName = "chatgpt-conversation-" + data.conversation_id + ".json";
        const compressed = await compressJsonAsZipOrPlain(json, jsonFileName);

        // A user can cancel while native compression is still underway.
        if (signal.aborted) {
            const error = new Error("Export cancelled during compression.");
            error.name = "AbortError";
            throw error;
        }

        if (compressed.warning) {
            console.warn("[ChatGPT Conversation Exporter]", compressed.warning);
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
            warning: compressed.warning
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
                        " message records; checking for older pages"
                    );
                }
            });

            if (!output.local_export_audit.pagination_verified) {
                throw new Error("Pagination end was not verified.");
            }

            const result = await download(output, signal);
            state.profiler.noteDownload(result);
            report(
                "Export complete – " + result.format.toUpperCase() +
                    " download started.",
                output.local_export_audit.pages_loaded + " API pages, " +
                output.local_export_audit.unique_records + " unique message records; " +
                result.sizeMiB + " MiB – " + result.fileName +
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
            alignItems: "center", gap: "5px"
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

        // Adjacent compact gear opens the numeric settings panel.
        const settings = document.createElement("button");
        settings.id = "chatgpt-conversation-export-mode-button";
        settings.type = "button";
        settings.textContent = "⚙";
        settings.title = "Export performance settings";
        settings.setAttribute("aria-label", settings.title);
        Object.assign(settings.style, {
            display: "inline-flex", alignItems: "center",
            justifyContent: "center", width: "27px", height: "27px",
            padding: "0", border: "1px solid #8c99a8",
            borderRadius: "6px", color: "#fff", background: "#253144",
            cursor: "pointer", font: "18px/1 system-ui, sans-serif",
            boxShadow: "0 3px 12px rgba(0,0,0,.25)"
        });
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

})();
