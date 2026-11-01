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
