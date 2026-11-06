"use strict";

// Single runtime version shared by the settings UI and performance reports.
const USERSCRIPT_VERSION = "0.3.2";

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
    function activeElapsedMs(started) {
        // Keep the status message and the exported performance report on
        // the same cumulative active-time basis. While a run is in progress,
        // include its elapsed time without finalizing it or counting it twice.
        return ms(activeRunMs + Math.max(0, now() - started));
    }
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
            userscript_version: USERSCRIPT_VERSION,
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
        instrumentFetch, trackPage, runStarted, runEnded, activeElapsedMs,
        noteDownload, hasSamples, report
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = { createExportProfiler };
}
