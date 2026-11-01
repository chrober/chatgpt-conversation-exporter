"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const {
    parseConversationUrl,
    validatePage,
    assembleExport,
    createExportSession
} = require("../src/exporter-core.js");

const ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const CHAT = "https://chatgpt.com/g/g-p-example/c/" + ID;
const SOURCE = CHAT;
const ok = body => ({
    ok: true,
    status: 200,
    json: async () => body
});
const fail = status => ({ ok: false, status });
const msg = (id, role = "assistant", value = id) => ({
    id, author: { role }, content: { parts: [value] }, metadata: {}
});
const page = (messages, cursor, more) => ({
    messages,
    safe_urls: [],
    blocked_urls: [],
    page_info: {
        start_cursor: cursor,
        end_cursor: messages.at(-1).id,
        has_previous_page: more,
        has_next_page: true
    }
});

function fixture(pages) {
    const calls = [];
    const fetchImpl = async (url, options) => {
        calls.push({ url, options });
        if (url === "/api/auth/session") return ok({ accessToken: "test-token" });
        const params = new URL(url, "https://chatgpt.com").searchParams;
        const before = params.get("before") ?? "";
        const response = pages[before];
        if (!response) throw new Error("Unexpected cursor: " + before);
        return response;
    };
    return { calls, fetchImpl };
}

function session(fetchImpl, extra = {}) {
    return createExportSession({
        sourceUrl: SOURCE,
        fetchImpl,
        sleep: async () => {},
        requestDelayMs: 0,
        ...extra
    });
}

test("original and project URLs work; query/hash stripped; shares rejected", () => {
    assert.equal(parseConversationUrl(
        "https://chatgpt.com/c/" + ID + "?model=foo#bar"
    ).sourceUrl, "https://chatgpt.com/c/" + ID);
    assert.equal(parseConversationUrl(CHAT).conversationId, ID);
    assert.throws(() => parseConversationUrl("https://chatgpt.com/share/" + ID));
    assert.throws(() => parseConversationUrl("https://example.com/c/" + ID));
    assert.throws(() => parseConversationUrl("https://chatgpt.com/c/not-a-uuid"));
});

test("paged export preserves originals, order, metadata, audit and token privacy", async () => {
    const { calls, fetchImpl } = fixture({
        "": ok(page([msg("m3"), msg("m4")], "cursor-newer", true)),
        "cursor-newer": ok(page([msg("m1", "user"), msg("m2")], "cursor-older", false))
    });
    const output = await session(fetchImpl).run();
    assert.deepEqual(output.messages.map(x => x.id), ["m1", "m2", "m3", "m4"]);
    assert.equal(output.export_format, "chatgpt-paginated-conversation-v2");
    assert.equal(output.conversation_id, ID);
    assert.equal(output.source_url, SOURCE);
    assert.equal(output.page_metadata.length, 2);
    assert.equal(output.page_metadata[0].message_count, 2);
    assert.equal(output.local_export_audit.pagination_verified, true);
    assert.equal(output.local_export_audit.unique_records, 4);
    assert.equal(output.local_export_audit.attachments_fetched_separately, false);
    assert.equal(JSON.stringify(output).includes("test-token"), false);
    const pageCalls = calls.filter(x => x.url.includes("/messages?"));
    assert.equal(pageCalls.length, 2);
    assert.match(pageCalls[0].url, /num_turns=1/);
    assert.match(pageCalls[0].url, /include_has_versions=true/);
    assert.match(pageCalls[1].url, /before=cursor-newer/);
    // Actually pages progress by first page's start_cursor, not its last.
    assert.equal(pageCalls[1].options.headers.Authorization, "Bearer test-token");
});

test("HTTP 500 is retried, 403 is not", async () => {
    let requests = 0;
    const fetchImpl = async url => {
        if (url === "/api/auth/session") return ok({});
        requests++;
        return requests === 1 ? fail(500) :
            ok(page([msg("m1")], "cursor-end", false));
    };
    const output = await session(fetchImpl).run();
    assert.equal(output.messages.length, 1);
    assert.equal(requests, 2);

    let denied = 0;
    const forbidden = async url => {
        if (url === "/api/auth/session") return ok({});
        denied++;
        return fail(403);
    };
    await assert.rejects(session(forbidden).run(), /HTTP 403/);
    assert.equal(denied, 1);
});

test("resume after all retries exhausted preserves the validated first page", async () => {
    let errorsRemaining = 4;
    const calls = [];
    const fetchImpl = async url => {
        if (url === "/api/auth/session") return ok({});
        const before = new URL(url, "https://chatgpt.com").searchParams.get("before");
        calls.push(before);
        if (!before) return ok(page([msg("newest")], "c-new", true));
        if (errorsRemaining-- > 0) return fail(503);
        return ok(page([msg("oldest")], "c-old", false));
    };

    const exportSession = session(fetchImpl);
    await assert.rejects(exportSession.run(), /HTTP 503/);
    assert.equal(exportSession.snapshot().pages, 1);
    assert.equal(exportSession.snapshot().completed, false);
    const output = await exportSession.run();
    assert.deepEqual(output.messages.map(x => x.id), ["oldest", "newest"]);
    assert.equal(calls.filter(x => x === null).length, 1);
});

test("abort after a validated page preserves it for resume", async () => {
    const fetchImpl = fixture({
        "": ok(page([msg("latest")], "c-latest", true)),
        "c-latest": ok(page([msg("older")], "c-older", false))
    }).fetchImpl;
    const exporter = session(fetchImpl);
    const controller = new AbortController();
    await assert.rejects(
        exporter.run({
            signal: controller.signal,
            onProgress: () => controller.abort()
        }),
        { name: "AbortError" }
    );
    assert.equal(exporter.snapshot().pages, 1);
    const output = await exporter.run();
    assert.equal(output.messages.length, 2);
    assert.equal(exporter.snapshot().completed, true);
});

test("repeated cursors fail without claiming completeness", async () => {
    const { fetchImpl } = fixture({
        "": ok(page([msg("first")], "same", true)),
        "same": ok(page([msg("second")], "same", true))
    });
    const exporter = session(fetchImpl);
    await assert.rejects(exporter.run(), /Wiederholter Cursor/);
    assert.equal(exporter.snapshot().pages, 1);
    assert.equal(exporter.snapshot().completed, false);
});

test("missing cursor, malformed pages and max-page limit fail closed", async () => {
    assert.throws(() => validatePage({ messages: [msg("x")], page_info: {
        has_previous_page: true
    }}), /Start-Cursor/);
    assert.throws(() => validatePage({ messages: [], page_info: {
        has_previous_page: false
    }}), /leere/);
    const { fetchImpl } = fixture({
        "": ok(page([msg("latest")], "c1", true))
    });
    const exporter = session(fetchImpl, { maxPages: 1 });
    await assert.rejects(exporter.run(), /Maximale Seitenzahl/);
    assert.equal(exporter.snapshot().pages, 1);
});

test("conflicting duplicate ID fails; identical overlap is deduplicated", () => {
    const newer = page([msg("shared", "assistant", "same")], "n", true);
    const older = page([msg("shared", "assistant", "same")], "o", false);
    const output = assembleExport([newer, older], ID, SOURCE);
    assert.equal(output.local_export_audit.raw_records, 2);
    assert.equal(output.local_export_audit.unique_records, 1);
    assert.equal(output.local_export_audit.duplicate_records, 1);
    older.messages[0].content.parts[0] = "changed";
    assert.throws(() => assembleExport([newer, older], ID, SOURCE), /Widersprüchliche/);
});

test("download bundle is self-contained and command does not auto-export", () => {
    const code = fs.readFileSync(path.join(
        __dirname, "../userscripts/chatgpt-conversation-export.user.js"
    ), "utf8");
    assert.match(code, /@grant\s+GM\.registerMenuCommand/);
    assert.doesNotMatch(code, /@require/);
    let menu;
    const context = {
        GM: {
            registerMenuCommand: (label, callback) => { menu = { label, callback }; }
        }
    };
    vm.runInNewContext(code, context);
    assert.match(menu.label, /JSON exportieren/);
    assert.equal(typeof menu.callback, "function");
    // No DOM, fetch or download activity before the explicit menu action.
});
