"use strict";

/**
 * Best-effort attachment discovery from already-exported conversation records.
 * ChatGPT file endpoints are undocumented; never infer that a reference means
 * the binary still exists. No URLs, signed tokens or raw messages are logged.
 */
const FILE_ID_PATTERN = /^file_[a-zA-Z0-9]{8,}$/;
const MAX_ATTACHMENT_COUNT = 100;
const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 200 * 1024 * 1024;

function fileIdFromPointer(value) {
    if (typeof value !== "string") return null;
    const match = /(?:^|[:/])((?:file_)[a-zA-Z0-9]{8,})(?:$|[/?#])/i.exec(value);
    return match && FILE_ID_PATTERN.test(match[1]) ? match[1] : null;
}

function safeAttachmentName(value, fallback) {
    const raw = typeof value === "string" ? value.split(/[\\/]/).at(-1) : "";
    const clean = raw.replace(/[\x00-\x1f\x7f<>:"|?*]/g, "_")
        .replace(/^[. ]+|[. ]+$/g, "").slice(0, 120);
    return clean && clean !== "." && clean !== ".." ? clean : fallback;
}

function safeSandboxPath(value) {
    if (typeof value !== "string") return null;
    let path = value.replace(/^sandbox:/, "");
    try { path = decodeURIComponent(path); } catch { return null; }
    if (!path.startsWith("/mnt/data/") || path.length > 1024 ||
        path.includes("\\") || path.includes("\x00") ||
        path.split("/").some(part => part === "." || part === "..")) {
        return null;
    }
    return path;
}

function discoverAttachments(messages, maxCount = MAX_ATTACHMENT_COUNT) {
    const files = new Map();
    function record(kind, identifier, name, message, source = "unknown",
        referenceKeys = []) {
        if (!identifier) return;
        const key = kind + ":" + identifier + (kind === "sandbox" ? ":" + message.id : "");
        const fallback = kind === "file" ? identifier : "generated-file";
        if (files.has(key)) {
            const existing = files.get(key);
            if (!existing.message_ids.includes(message.id)) {
                existing.message_ids.push(message.id);
            }
            // The pointer scheme tells us which ChatGPT API route to try
            // first. Preserve it if later metadata carries that detail.
            if (source === "sediment" || source === "file-service") {
                existing.source = source;
            }
            existing.reference_keys = [...new Set([
                ...existing.reference_keys, ...referenceKeys
            ])].sort();
            return;
        }
        files.set(key, {
            kind, identifier, source,
            // Record *field names*, never contents, to diagnose ambiguous
            // metadata-id references without leaking ChatGPT payloads.
            reference_keys: [...new Set(referenceKeys)].sort(),
            file_name: safeAttachmentName(name, fallback),
            message_ids: [message.id],
            role: message.author?.role ?? "unknown"
        });
    }
    function scan(obj, message, depth = 0, seen = new Set()) {
        if (!obj || typeof obj !== "object" || seen.has(obj) || depth > 6) return;
        seen.add(obj);
        if (Array.isArray(obj)) {
            for (const item of obj.slice(0, 1000)) scan(item, message, depth + 1, seen);
            return;
        }
        const name = obj.name || obj.file_name || obj.filename ||
            obj.original_filename || obj.display_name;
        const referenceKeys = [
            "id", "file_id", "fileId", "asset_pointer", "assetPointer",
            "name", "file_name", "filename", "mime_type", "size_bytes",
            "upload_id", "source", "content_type"
        ].filter(key => Object.hasOwn(obj, key));
        const candidates = [
            [obj.file_id, "file-id"], [obj.fileId, "file-id"],
            [obj.asset_pointer, "pointer"], [obj.assetPointer, "pointer"],
            [obj.id, "metadata-id"]
        ];
        for (const [candidate, field] of candidates) {
            const id = fileIdFromPointer(candidate);
            if (!id) continue;
            const source = typeof candidate === "string" &&
                candidate.startsWith("sediment://") ? "sediment" :
                typeof candidate === "string" &&
                candidate.startsWith("file-service://") ? "file-service" : field;
            record("file", id, name, message, source, referenceKeys);
        }
        // Some generated file cards expose a sandbox path structurally.
        for (const value of [obj.sandbox_path, obj.sandbox_url]) {
            const path = safeSandboxPath(value);
            if (path && message.author?.role === "assistant") {
                record("sandbox", path, name || path, message);
            }
        }
        for (const [key, value] of Object.entries(obj)) {
            if (["parts", "attachments", "content", "asset",
                "assets", "images", "files", "image", "metadata"].includes(key)) {
                scan(value, message, depth + 1, seen);
            }
        }
    }
    for (const message of messages) {
        if (!message || typeof message.id !== "string") continue;
        scan(message.metadata?.attachments, message);
        scan(message.attachments, message);
        scan(message.content, message);
        // Markdown sandbox links in assistant output; don't extract arbitrary
        // URLs or file IDs from user prose or quoted examples.
        if (message.author?.role === "assistant") {
            for (const part of message.content?.parts ?? []) {
                if (typeof part !== "string") continue;
                const regex = /\[[^\]\n]{1,200}\]\((sandbox:\/mnt\/data\/[^\s)#]+)\)/g;
                for (const match of part.matchAll(regex)) {
                    const path = safeSandboxPath(match[1]);
                    if (path) record("sandbox", path, path, message);
                }
            }
        }
    }
    const found = [...files.values()];
    return {
        items: found.slice(0, maxCount),
        skipped_count: Math.max(0, found.length - maxCount)
    };
}

function attachmentURLKind(url) {
    try {
        const parsed = new URL(url, "https://chatgpt.com");
        if (parsed.protocol !== "https:" || parsed.username ||
            parsed.password || parsed.hash || parsed.port) return null;
        if (parsed.hostname === "chatgpt.com" &&
            parsed.pathname.startsWith("/backend-api/")) return "same-origin";
        // HAR-confirmed signed media origin. Hostnames vary by region.
        if (/^[a-z0-9-]+\.oaiusercontent\.com$/i.test(parsed.hostname) &&
            /^\/files\/[0-9a-f]{8}-[0-9a-f-]{20,}\/raw$/i.test(parsed.pathname) &&
            parsed.searchParams.has("sig") && parsed.searchParams.has("se")) {
            return "signed-oaiusercontent";
        }
        return null;
    } catch { return null; }
}

function allowedAttachmentURL(url) {
    return attachmentURLKind(url) !== null;
}

async function readBoundedResponse(response, limit) {
    const declared = Number(response.headers?.get("content-length"));
    if (Number.isFinite(declared) && declared > limit) {
        throw new Error("file exceeds the per-file size limit");
    }
    if (response.headers?.get("content-type")?.includes("text/html")) {
        throw new Error("download returned HTML instead of file bytes");
    }
    if (!response.body?.getReader) {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > limit) throw new Error("file exceeds the size limit");
        return bytes;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) throw new Error("file exceeds the size limit");
            chunks.push(value);
        }
    } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}


function projectGizmoIdFromSource(sourceUrl, conversationId) {
    if (typeof conversationId !== "string") return null;
    try {
        const url = new URL(sourceUrl);
        if (url.origin !== "https://chatgpt.com") return null;
        const match = /^\/g\/(g-p-[a-f0-9]{32})(?:-[^/]*)?\/c\/([a-f0-9-]{36})\/?$/i
            .exec(url.pathname);
        return match && match[2].toLowerCase() ===
            conversationId.toLowerCase() ? match[1] : null;
    } catch { return null; }
}

function attachmentMetadataRoutes(item, conversationId, options = {}) {
    if (item.kind === "sandbox") {
        return [{
            label: "interpreter",
            url: "/backend-api/conversation/" +
                encodeURIComponent(conversationId) + "/interpreter/download?" +
                new URLSearchParams({
                    message_id: item.message_ids[0],
                    sandbox_path: item.identifier
                })
        }];
    }
    const id = encodeURIComponent(item.identifier);
    const conversation = encodeURIComponent(conversationId);
    const projectGizmo = typeof options.gizmoId === "string" &&
        /^g-p-[a-f0-9]{32}$/i.test(options.gizmoId) ?
        options.gizmoId : null;
    const projectQuery = projectGizmo ?
        "?gizmo_id=" + encodeURIComponent(projectGizmo) : "";
    const routes = [
        { label: "files-by-id", url: "/backend-api/files/" + id + "/download" },
        { label: "conversation-attachment", url: "/backend-api/conversation/" +
            conversation + "/attachment/" + id + "/download" +
            projectQuery },
        { label: "files-download", url: "/backend-api/files/download/" + id +
            "?conversation_id=" + conversation + "&inline=false" }
    ];
    if (item.source === "sediment" ||
        (projectGizmo && item.source === "metadata-id")) {
        // In a real project HAR, the conversation-attachment route with
        // gizmo_id returned HTTP 200 for a metadata-id upload.
        return [routes[1], routes[0], routes[2]];
    }
    return routes;
}

async function attachmentAuthHeaders(fetchImpl, signal) {
    const response = await fetchImpl("/api/auth/session", {
        credentials: "include", cache: "no-store", redirect: "error", signal
    });
    if (!response.ok) {
        throw new Error("session HTTP " + response.status);
    }
    const session = await response.json();
    const token = session?.accessToken ?? session?.access_token;
    // Never store the token in the ZIP or report and never send it to
    // non-ChatGPT origins.
    return token ? { Authorization: "Bearer " + token } : {};
}

async function resolveDownloadMetadata(item, conversationId, fetchImpl,
    headers, signal, context = {}) {
    const tried = [];
    const routeStatuses = [];
    let lastHttp = null;
    for (const route of attachmentMetadataRoutes(item, conversationId, context)) {
        tried.push(route.label);
        const response = await fetchImpl(route.url, {
            credentials: "include", headers: {
                ...headers, Accept: "application/json"
            }, cache: "no-store", redirect: "error", signal
        });
        if (!response.ok) {
            lastHttp = response.status;
            routeStatuses.push({
                resolver: route.label,
                status: Number.isInteger(response.status) ?
                    response.status : null
            });
            // Only a missing route/file permits a different read-only
            // resolver. Never probe other routes on 401, 403 or rate limits.
            if (response.status === 404 || response.status === 410) continue;
            return { meta: null, tried, routeStatuses,
                error: "metadata HTTP " + (response.status ?? "error") };
        }
        const meta = await response.json();
        routeStatuses.push({ resolver: route.label, status: 200 });
        return { meta, tried, routeStatuses, resolved_by: route.label };
    }
    return { meta: null, tried, routeStatuses,
        error: "metadata HTTP " + (lastHttp ?? "error") };
}

async function collectAttachments(messages, conversationId, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const signal = options.signal;
    const onProgress = options.onProgress ?? (() => {});
    const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
    const totalLimit = options.totalBytes ?? MAX_TOTAL_ATTACHMENT_BYTES;
    const discovery = discoverAttachments(messages);
    const records = [], entries = [];
    let totalBytes = 0;
    let authHeaders = options.authHeaders;
    if (authHeaders === undefined && discovery.items.length) {
        try {
            authHeaders = await attachmentAuthHeaders(fetchImpl, signal);
        } catch (error) {
            if (signal?.aborted || error.name === "AbortError") throw error;
            // Cookies can still be sufficient on some ChatGPT installations.
            authHeaders = {};
        }
    }
    authHeaders ??= {};
    for (const [index, item] of discovery.items.entries()) {
        if (signal?.aborted) {
            const error = new Error("Attachment download cancelled.");
            error.name = "AbortError";
            throw error;
        }
        onProgress(index + 1, discovery.items.length);
        const itemRecord = {
            kind: item.kind,
            file_name: item.file_name,
            message_ids: item.message_ids,
            role: item.role,
            source: item.source,
            reference_keys: item.reference_keys,
            conversation_scope: options.conversationScope === "project" ?
                "project" : "regular_or_unknown",
            auth_mode: authHeaders.Authorization ? "bearer_and_cookies" :
                "cookies_only",
            resolver_http_statuses: [],
            resolver_routes_tried: [],
            resolved_by: null,
            status: "failed",
            stored_path: null,
            size_bytes: null,
            error: null
        };
        try {
            const resolution = await resolveDownloadMetadata(
                item, conversationId, fetchImpl, authHeaders, signal, {
                    gizmoId: options.gizmoId
                }
            );
            itemRecord.resolver_routes_tried = resolution.tried;
            itemRecord.resolver_http_statuses = resolution.routeStatuses;
            itemRecord.resolved_by = resolution.resolved_by ?? null;
            if (!resolution.meta) {
                throw new Error(resolution.error);
            }
            const meta = resolution.meta;
            const url = meta.download_url || meta.url;
            if (!url || !allowedAttachmentURL(url)) {
                throw new Error("no supported same-origin download URL");
            }
            const kind = attachmentURLKind(url);
            if (!kind) throw new Error("unsupported download URL");
            const response = await fetchImpl(url, kind === "same-origin" ? {
                credentials: "include", headers: authHeaders,
                signal, redirect: "error"
            } : {
                // The signed CDN request must not carry browser credentials
                // or the ChatGPT bearer token across origins.
                credentials: "omit", mode: "cors", redirect: "error",
                referrerPolicy: "no-referrer", signal
            });
            if (!response.ok) {
                throw new Error("file HTTP " + (response.status ?? "error"));
            }
            const bytes = await readBoundedResponse(response,
                Math.min(maxBytes, totalLimit - totalBytes));
            const filename = safeAttachmentName(
                meta.file_name || item.file_name, item.file_name);
            // Avoid overwriting duplicates, collisions, or path traversal.
            const path = "attachments/" +
                String(index + 1).padStart(3, "0") + "-" + filename;
            entries.push({ name: path, bytes });
            totalBytes += bytes.byteLength;
            itemRecord.file_name = filename;
            itemRecord.status = "downloaded";
            itemRecord.stored_path = path;
            itemRecord.size_bytes = bytes.byteLength;
        } catch (error) {
            if (signal?.aborted || error.name === "AbortError") throw error;
            // Sanitized: never expose signed URLs, tokens, or arbitrary
            // response contents in manifest/error messages.
            const text = String(error.message || "");
            itemRecord.error = /size limit|size limit|per-file size limit/.test(text) ?
                "size_limit" : /metadata HTTP \d+/.test(text) ?
                    text : /file HTTP \d+/.test(text) ?
                    text : /same-origin/.test(text) ?
                    "unsupported_download_url" : "unavailable";
        }
        records.push(itemRecord);
    }
    const summary = {
        discovered: discovery.items.length + discovery.skipped_count,
        attempted: discovery.items.length,
        downloaded: entries.length,
        failed: records.length - entries.length,
        skipped_limit: discovery.skipped_count,
        bytes_downloaded: totalBytes
    };
    return {
        entries,
        manifest: {
            manifest_format: "chatgpt-conversation-attachments-v1",
            summary,
            items: records
        },
        summary
    };
}

if (typeof module !== "undefined" && module.exports) {
    module.exports = {
        discoverAttachments, collectAttachments,
        fileIdFromPointer, safeSandboxPath, safeAttachmentName,
        readBoundedResponse, allowedAttachmentURL, attachmentURLKind,
        projectGizmoIdFromSource,
        attachmentMetadataRoutes, attachmentAuthHeaders,
        resolveDownloadMetadata
    };
}
