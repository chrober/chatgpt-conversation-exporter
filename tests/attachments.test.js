"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
    discoverAttachments, collectAttachments, safeSandboxPath,
    allowedAttachmentURL, readBoundedResponse
} = require("../src/attachments.js");
const { compressFilesToZip } = require("../src/compression.js");
const { readExport, compareExports } = require("../scripts/compare-exports.js");

const CID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FILE = "file_0000000012345678abcdef1234567890";
const item = (id, role, content, attachments) => ({
    id, author: { role }, content: { parts: content },
    metadata: { attachments: attachments || [] }
});

test("discovers and deduplicates upload, image and assistant sandbox references", () => {
    const messages = [
        item("user-1", "user",
            [{ content_type: "image_asset_pointer", asset_pointer: "sediment://" + FILE }],
            [{ id: FILE, name: "../../uploaded.pdf" }]),
        item("user-2", "user", ["look at image"], [{ file_id: FILE }]),
        item("agent-1", "assistant",
            ["A report: [sheet](sandbox:/mnt/data/output/report.xlsx)"])
    ];
    const d = discoverAttachments(messages);
    assert.equal(d.items.length, 2);
    const file = d.items.find(x => x.kind === "file");
    assert.deepEqual(file.message_ids, ["user-1", "user-2"]);
    assert.equal(file.file_name, "uploaded.pdf");
    assert.equal(d.items.find(x => x.kind === "sandbox").identifier,
        "/mnt/data/output/report.xlsx");
});

test("does not download arbitrary links, user-written sandbox examples or traversal", () => {
    const messages = [
        item("u", "user", ["[sample](sandbox:/mnt/data/private.csv)"]),
        item("a", "assistant", ["[web](https://example.com/file.pdf)"]),
        item("x", "assistant", ["[bad](sandbox:/mnt/data/../token.txt)"])
    ];
    assert.equal(discoverAttachments(messages).items.length, 0);
    assert.equal(safeSandboxPath("sandbox:/mnt/data/../unsafe"), null);
    assert.equal(safeSandboxPath("/etc/passwd"), null);
    assert.equal(allowedAttachmentURL("https://evil.com/backend-api/estuary/content"), false);
    assert.equal(allowedAttachmentURL("http://chatgpt.com/backend-api/x"), false);
    assert.equal(allowedAttachmentURL("https://chatgpt.com/backend-api/estuary/content"), true);
});

test("downloads a file reference through same-origin signed URL and returns manifest", async () => {
    const calls = [];
    const bytes = new TextEncoder().encode("binary payload");
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (String(url).startsWith("/backend-api/files/download/")) {
            return { ok: true, json: async () => ({
                download_url: "https://chatgpt.com/backend-api/estuary/content?sig=SECRET",
                file_name: "/unsafe/path/uploaded.bin"
            }) };
        }
        return {
            ok: true, headers: { get: () => "13" },
            arrayBuffer: async () => bytes.buffer
        };
    };
    const result = await collectAttachments(
        [item("m1", "user", [], [{ file_id: FILE, name: "uploaded.bin" }])],
        CID, { fetchImpl, authHeaders: {} });
    assert.equal(result.summary.downloaded, 1);
    assert.equal(result.summary.failed, 0);
    assert.equal(result.entries.length, 1);
    assert.match(result.entries[0].name, /^attachments\/001-uploaded.bin$/);
    assert.deepEqual([...result.entries[0].bytes], [...bytes]);
    assert.equal(result.manifest.items[0].stored_path, result.entries[0].name);
    assert.equal(JSON.stringify(result.manifest).includes("SECRET"), false);
    assert.equal(calls[1].options.credentials, "include");
    assert.equal(calls[1].options.redirect, "error");
});

test("attempts agent sandbox links using message ID and interpreter endpoint", async () => {
    const calls = [];
    const fetchImpl = async url => {
        calls.push(url);
        if (calls.length === 1) {
            return { ok: true, json: async () => ({
                download_url: "/backend-api/estuary/content?id=mock"
            }) };
        }
        return {
            ok: true, headers: { get: () => null },
            arrayBuffer: async () => new Uint8Array([2, 3, 4]).buffer
        };
    };
    const res = await collectAttachments([
        item("agent-message", "assistant",
            ["[Output](sandbox:/mnt/data/output.csv)"])
    ], CID, { fetchImpl, authHeaders: {} });
    assert.equal(res.summary.downloaded, 1);
    assert.match(calls[0], /message_id=agent-message/);
    assert.match(calls[0], /sandbox_path=%2Fmnt%2Fdata%2Foutput.csv/);
});

test("unavailable files and non-ChatGPT URLs are recorded but never fetched", async () => {
    let calls = 0;
    const fetchImpl = async () => {
        calls++;
        return { ok: true, json: async () => ({
            download_url: "https://not-chatgpt.example/private?sig=SECRET"
        }) };
    };
    const res = await collectAttachments([
        item("m1", "user", [], [{ file_id: FILE }])
    ], CID, { fetchImpl, authHeaders: {} });
    assert.equal(calls, 1);
    assert.equal(res.summary.failed, 1);
    assert.equal(res.manifest.items[0].error, "unsupported_download_url");
    assert.equal(JSON.stringify(res.manifest).includes("SECRET"), false);
});

test("size-limited binary reader rejects declared and streamed overages", async () => {
    await assert.rejects(readBoundedResponse({
        headers: { get: name => name === "content-length" ? "900" : null },
        arrayBuffer: async () => { throw Error("must not read"); }
    }, 100), /size limit/);
    const reader = {
        index: 0, released: false,
        async read() {
            return this.index++ === 0 ?
                { done: false, value: new Uint8Array(101) } : { done: true };
        },
        async cancel() {},
        releaseLock() { this.released = true; }
    };
    await assert.rejects(readBoundedResponse({
        headers: { get: () => null },
        body: { getReader: () => reader }
    }, 100), /size limit/);
    assert.equal(reader.released, true);
});

test("multifile ZIP retains exact conversation JSON, manifest and binary entries", async t => {
    const json = JSON.stringify({
        messages: [{ id: "one", author: { role: "user" } }],
        local_export_audit: { pagination_verified: true }
    });
    const result = await compressFilesToZip([
        { name: "chatgpt-conversation-" + CID + ".json", bytes: json },
        { name: "attachments-manifest.json", bytes: "{}" },
        { name: "attachments/001-file.dat", bytes: new Uint8Array([0, 1, 2, 255]) }
    ], { CompressionStream: null, Response: null });
    const bytes = Buffer.from(await result.blob.arrayBuffer());
    assert.equal(bytes.readUInt32LE(0), 0x04034b50);
    assert.equal(bytes.readUInt16LE(bytes.length - 22 + 10), 3);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "attachments-compare-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const archive = path.join(dir, "attached.zip");
    fs.writeFileSync(archive, bytes);
    assert.equal(readExport(archive).messages.length, 1);
    assert.equal(compareExports(readExport(archive), JSON.parse(json)).verdict, "identical");
});

test("multifile ZIP refuses unsafe and duplicate paths", async () => {
    const files = [
        { name: "chat.json", bytes: "x" },
        { name: "chat.json", bytes: "y" }
    ];
    await assert.rejects(compressFilesToZip(files, {
        CompressionStream: null, Response: null
    }), /duplicate/);
    await assert.rejects(compressFilesToZip([
        { name: "attachments/../secrets.txt", bytes: "x" }
    ], { CompressionStream: null, Response: null }), /Unsafe/);
});


test("file-service pointer uses by-id endpoint first with bearer authorization", async () => {
    const id = "file_0123456789ABCDEF1234567890";
    const messages = [item("a", "user", [{
        asset_pointer: "file-service://" + id, name: "sample.7z"
    }])];
    const discovery = discoverAttachments(messages);
    assert.equal(discovery.items[0].source, "file-service");
    const calls = [];
    const result = await collectAttachments(messages, CID, {
        authHeaders: { Authorization: "Bearer TEST_TOKEN" },
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            if (calls.length === 1) return {
                ok: true, json: async () => ({
                    download_url: "/backend-api/estuary/content?id=mock"
                })
            };
            return {
                ok: true, headers: { get: () => null },
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer
            };
        }
    });
    assert.equal(result.summary.downloaded, 1);
    assert.match(calls[0].url, new RegExp("/backend-api/files/" + id + "/download$"));
    assert.equal(calls[0].options.headers.Authorization, "Bearer TEST_TOKEN");
    assert.equal(calls[1].options.headers.Authorization, "Bearer TEST_TOKEN");
    assert.deepEqual(result.manifest.items[0].resolver_routes_tried, ["files-by-id"]);
    assert.equal(result.manifest.items[0].resolved_by, "files-by-id");
    assert.equal(JSON.stringify(result.manifest).includes("TEST_TOKEN"), false);
});

test("sediment pointer tries conversation attachment first and falls back on 404", async () => {
    const id = "file_0123456789ABCDEF1234567890";
    const messages = [item("a", "user", [{
        asset_pointer: "sediment://" + id, name: "sample.7z"
    }])];
    const calls = [];
    const result = await collectAttachments(messages, CID, {
        authHeaders: {},
        fetchImpl: async url => {
            calls.push(url);
            if (calls.length === 1) return { ok: false, status: 404 };
            if (calls.length === 2) return {
                ok: true, json: async () => ({
                    download_url: "/backend-api/estuary/content?id=mock"
                })
            };
            return {
                ok: true, headers: { get: () => null },
                arrayBuffer: async () => new Uint8Array([1, 2]).buffer
            };
        }
    });
    assert.equal(result.summary.downloaded, 1);
    assert.match(calls[0], new RegExp("/conversation/" + CID + "/attachment/" + id + "/download$"));
    assert.match(calls[1], new RegExp("/files/" + id + "/download$"));
    assert.deepEqual(result.manifest.items[0].resolver_routes_tried,
        ["conversation-attachment", "files-by-id"]);
    assert.equal(result.manifest.items[0].resolved_by, "files-by-id");
});

test("file-ID fallback uses legacy resolver on two 404 responses", async () => {
    const urls = [];
    const res = await collectAttachments([
        item("a", "user", [], [{ file_id: FILE, name: "archive.7z" }])
    ], CID, {
        authHeaders: {},
        fetchImpl: async url => {
            urls.push(url);
            if (urls.length < 3) return { ok: false, status: 404 };
            if (urls.length === 3) return {
                ok: true, json: async () => ({
                    download_url: "/backend-api/estuary/content?id=ok"
                })
            };
            return {
                ok: true, headers: { get: () => null },
                arrayBuffer: async () => new Uint8Array([1]).buffer
            };
        }
    });
    assert.equal(urls.length, 4);
    assert.match(urls[2], /\/backend-api\/files\/download\//);
    assert.equal(res.summary.downloaded, 1);
    assert.equal(res.manifest.items[0].resolved_by, "files-download");
});

test("HTTP 403 stops route fallback and preserves diagnostic without URLs", async () => {
    const urls = [];
    const res = await collectAttachments([
        item("a", "user", [], [{ file_id: FILE }])
    ], CID, {
        authHeaders: {},
        fetchImpl: async url => {
            urls.push(url);
            return { ok: false, status: 403 };
        }
    });
    assert.equal(urls.length, 1);
    assert.equal(res.summary.failed, 1);
    assert.equal(res.manifest.items[0].error, "metadata HTTP 403");
    assert.deepEqual(res.manifest.items[0].resolver_routes_tried, ["files-by-id"]);
});

test("404 diagnostics include all three attempted resolvers without claiming file deletion", async () => {
    const urls = [];
    const res = await collectAttachments([
        item("a", "user", [], [{ file_id: FILE }])
    ], CID, {
        authHeaders: {},
        fetchImpl: async url => {
            urls.push(url);
            return { ok: false, status: 404 };
        }
    });
    assert.equal(urls.length, 3);
    assert.equal(res.manifest.items[0].error, "metadata HTTP 404");
    assert.deepEqual(res.manifest.items[0].resolver_routes_tried,
        ["files-by-id", "conversation-attachment", "files-download"]);
});

test("fetches session bearer for attachment metadata and same-origin binary", async () => {
    const urls = [], headers = [];
    const res = await collectAttachments([
        item("a", "user", [], [{ file_id: FILE }])
    ], CID, {
        fetchImpl: async (url, opts) => {
            urls.push(url);
            headers.push(opts.headers || {});
            if (url === "/api/auth/session") return {
                ok: true, json: async () => ({ accessToken: "SECRET_TOKEN" })
            };
            if (urls.length === 2) return {
                ok: true, json: async () => ({
                    download_url: "/backend-api/estuary/content?id=ok"
                })
            };
            return {
                ok: true, headers: { get: () => null },
                arrayBuffer: async () => new Uint8Array([5]).buffer
            };
        }
    });
    assert.equal(res.summary.downloaded, 1);
    assert.equal(urls.length, 3);
    assert.equal(urls[0], "/api/auth/session");
    assert.equal(headers[1].Authorization, "Bearer SECRET_TOKEN");
    assert.equal(headers[2].Authorization, "Bearer SECRET_TOKEN");
    assert.equal(JSON.stringify(res.manifest).includes("SECRET_TOKEN"), false);
});
