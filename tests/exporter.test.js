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
    await assert.rejects(exporter.run(), /Repeated page cursor/);
    assert.equal(exporter.snapshot().pages, 1);
    assert.equal(exporter.snapshot().completed, false);
});

test("missing cursor, malformed pages and max-page limit fail closed", async () => {
    assert.throws(() => validatePage({ messages: [msg("x")], page_info: {
        has_previous_page: true
    }}), /start cursor/);
    assert.throws(() => validatePage({ messages: [], page_info: {
        has_previous_page: false
    }}), /empty API page/);
    const { fetchImpl } = fixture({
        "": ok(page([msg("latest")], "c1", true))
    });
    const exporter = session(fetchImpl, { maxPages: 1 });
    await assert.rejects(exporter.run(), /Maximum API page limit/);
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
    assert.throws(() => assembleExport([newer, older], ID, SOURCE), /Conflicting message ID/);
});

test("download bundle is self-contained and command does not auto-export", () => {
    const code = fs.readFileSync(path.join(
        __dirname, "../userscripts/chatgpt-conversation-export.user.js"
    ), "utf8");
    assert.match(code, /@grant\s+GM\.registerMenuCommand/);
    assert.match(code, /@grant\s+GM_registerMenuCommand/);
    assert.doesNotMatch(code, /@require/);
    let menu;
    const context = {
        GM: {
            registerMenuCommand: (label, callback) => { menu = { label, callback }; }
        }
    };
    vm.runInNewContext(code, context);
    assert.match(menu.label, /Export current chat as JSON/);
    assert.equal(typeof menu.callback, "function");
    // No DOM, fetch or download activity before the explicit menu action.
});

test("Tampermonkey legacy menu API is registered without auto-export", () => {
    const code = fs.readFileSync(path.join(
        __dirname, "../userscripts/chatgpt-conversation-export.user.js"
    ), "utf8");
    let menu;
    const context = {
        GM_registerMenuCommand: (label, callback) => {
            menu = { label, callback };
        }
    };
    vm.runInNewContext(code, context);
    assert.equal(menu.label, "Export current chat as JSON");
    assert.equal(typeof menu.callback, "function");
});

test("the in-page launcher exists even without a userscript menu API", () => {
    const code = fs.readFileSync(path.join(
        __dirname, "../userscripts/chatgpt-conversation-export.user.js"
    ), "utf8");
    let launcher;
    let exported = false;
    const document = {
        body: { appendChild(node) {
            const children = node.children || [];
            launcher = node.id === "chatgpt-conversation-export-launcher" ?
                node : children.find(child =>
                    child.id === "chatgpt-conversation-export-launcher");
        } },
        getElementById: () => null,
        createElementNS: () => ({
            style: {},
            setAttribute() {},
            appendChild() {}
        }),
        createElement: () => ({
            style: {},
            children: [],
            setAttribute() {},
            appendChild(child) { this.children.push(child); },
            addEventListener(event, callback) {
                assert.equal(event, "click");
                this.onClick = callback;
            }
        })
    };
    vm.runInNewContext(code, {
        document,
        console: { info() {}, warn() {} },
        fetch: () => { exported = true; throw Error("unexpected fetch"); }
    });
    assert.equal(launcher.id, "chatgpt-conversation-export-launcher");
    assert.equal(launcher.textContent, "Export chat as JSON");
    assert.equal(typeof launcher.onClick, "function");
    assert.equal(exported, false);
});


test("profiling captures page timing and retries without collecting private data", async () => {
    const { createExportProfiler } = require("../src/profiling.js");
    let time = 100;
    const profiler = createExportProfiler({ now: () => time });
    let responseCount = 0;
    const confidentialUrl = "/backend-api/conversations/" + ID +
        "/messages?before=secret-cursor";
    const wrapper = profiler.instrumentFetch(async (_url, _options) => {
        time += 20;
        responseCount++;
        return {
            ok: responseCount > 1,
            status: responseCount > 1 ? 200 : 503,
            headers: { get: () => "512" },
            json: async () => {
                time += 5;
                return { messages: [msg("secret-message-id")] };
            }
        };
    }, () => 1);

    const first = await wrapper(confidentialUrl, {
        headers: { Authorization: "Bearer super-secret" }
    });
    assert.equal(first.ok, false);
    const second = await wrapper(confidentialUrl, {
        headers: { Authorization: "Bearer super-secret" }
    });
    await second.json();

    profiler.trackPage({ pages: 1, records: 11 });
    profiler.runEnded(profiler.runStarted() - 150);
    profiler.noteDownload({ serialization_ms: 36, json_bytes: 2048 });
    const profile = profiler.report();

    assert.equal(profile.completed, true);
    assert.equal(profile.summary.api_pages_completed, 1);
    assert.equal(profile.summary.message_records, 11);
    assert.equal(profile.summary.retries, 1);
    assert.equal(profile.summary.message_http_attempts, 2);
    assert.equal(profile.summary.request_status_counts["503"], 1);
    assert.equal(profile.summary.request_status_counts["200"], 1);
    assert.equal(profile.summary.network_header_wait_ms, 40);
    assert.equal(profile.summary.response_json_parse_ms, 5);
    assert.equal(profile.summary.json_serialization_ms, 36);
    assert.equal(profile.summary.exported_json_bytes, 2048);
    assert.equal(profile.pages[0].message_records, 11);
    const serialized = JSON.stringify(profile);
    for (const privateValue of [ID, "secret-cursor", "super-secret", "secret-message-id"]) {
        assert.equal(serialized.includes(privateValue), false);
    }
});

test("profiling reports an interrupted export as incomplete and never saves automatically", async () => {
    const { createExportProfiler } = require("../src/profiling.js");
    const profiler = createExportProfiler({ now: () => 10 });
    assert.equal(profiler.hasSamples(), false);
    const profile = profiler.report();
    assert.equal(profile.completed, false);
    assert.equal(profile.summary.api_pages_completed, 0);
    assert.equal(profile.summary.message_http_attempts, 0);
});

test("generated UI uses bottom-right launcher and a separate performance report action", () => {
    const entry = fs.readFileSync(path.join(__dirname, "../src/userscript-entry.js"), "utf8");
    assert.match(entry, /button\.textContent = "Export chat as JSON"/);
    assert.match(entry, /right: "18px"/);
    assert.doesNotMatch(entry, /left: "18px"/);
    assert.match(entry, /bottom: "68px"/);
    assert.match(entry, /Save performance report/);
    assert.match(entry, /API pages/);
    assert.match(entry, /state\.profiler\.noteDownload\(result\)/);
    assert.match(entry, /state\.profiler\.report\(\)/);
});


test("Cancel is replaced by Save performance report on completion", async () => {
    const code = fs.readFileSync(path.join(
        __dirname, "../userscripts/chatgpt-conversation-export.user.js"
    ), "utf8");

    const elements = [];
    function setConnected(node, value) {
        node.isConnected = value;
        for (const child of node.children) setConnected(child, value);
    }
    function node(tagName) {
        const element = {
            tagName,
            style: {},
            children: [],
            listeners: {},
            attributes: {},
            isConnected: false,
            disabled: false,
            setAttribute(key, value) { this.attributes[key] = value; },
            addEventListener(type, cb) { this.listeners[type] = cb; },
            appendChild(child) {
                this.children.push(child);
                setConnected(child, this.isConnected);
            },
            remove() { this.isConnected = false; },
            click() {}
        };
        elements.push(element);
        return element;
    }
    const body = node("body");
    body.isConnected = true;
    const document = {
        body,
        createElement: node,
        createElementNS: (_namespace, tagName) => node(tagName),
        getElementById: id => elements.find(e => e.id === id && e.isConnected) ?? null
    };
    let resolvePage;
    const fetchImpl = async url => {
        if (url === "/api/auth/session") {
            return { ok: true, status: 200, json: async () => ({}) };
        }
        return new Promise(resolve => { resolvePage = resolve; });
    };
    const context = {
        document,
        window: {
            location: {
                origin: "https://chatgpt.com",
                pathname: "/c/" + ID
            }
        },
        URL,
        URLSearchParams,
        TextEncoder,
        Blob,
        AbortController,
        performance,
        setTimeout: () => 0,
        console: { info() {}, warn() {} },
        GM_registerMenuCommand() {},
        fetch: fetchImpl
    };
    vm.runInNewContext(code, context);

    const launch = document.getElementById("chatgpt-conversation-export-launcher");
    assert.ok(launch);
    launch.listeners.click();
    await new Promise(resolve => setImmediate(resolve));

    const cancel = elements.find(e => e.textContent === "Cancel");
    assert.ok(cancel);
    assert.equal(cancel.disabled, false, JSON.stringify({
        statuses: elements.filter(e => typeof e.textContent === "string")
            .map(e => ({ tag: e.tagName, text: e.textContent, connected: e.isConnected })),
        pageStarted: typeof resolvePage === "function",
        cancelState: { disabled: cancel.disabled, opacity: cancel.style.opacity }
    }));
    assert.equal(cancel.style.opacity, "1");
    assert.equal(cancel.attributes["aria-disabled"], "false");
    assert.equal(typeof resolvePage, "function");

    resolvePage(ok(page([msg("one")], "cursor-end", false)));
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(cancel.hidden, true);
    assert.equal(cancel.style.display, "none");
    assert.ok(elements.some(e =>
        e.textContent === "Export complete – ZIP download started."
    ) || elements.some(e =>
        e.textContent === "Export complete – JSON download started."
    ));
    const profileAction = elements.find(e =>
        e.textContent === "Save performance report"
    );
    assert.ok(profileAction);
    assert.equal(profileAction.hidden, false);
    assert.equal(profileAction.style.display, "");
});


function makeExportUiHarness(storage = null, useAsyncStorage = false,
    browserSession = new Map(), clock = performance) {
    const code = fs.readFileSync(path.join(
        __dirname, "../userscripts/chatgpt-conversation-export.user.js"
    ), "utf8");
    const elements = [];
    const pending = [];
    const urls = class extends URL {};
    urls.createObjectURL = () => "blob:mock";
    urls.revokeObjectURL = () => {};
    let messageRequests = 0;
    const messageUrls = [];

    function setConnected(node, connected) {
        node.isConnected = connected;
        for (const child of node.children) setConnected(child, connected);
    }

    function element(tagName) {
        const item = {
            tagName,
            style: {},
            children: [],
            listeners: {},
            attributes: {},
            disabled: false,
            isConnected: false,
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(name, cb) { this.listeners[name] = cb; },
            appendChild(child) {
                this.children.push(child);
                setConnected(child, this.isConnected);
            },
            remove() { setConnected(this, false); },
            click() {}
        };
        elements.push(item);
        return item;
    }

    const body = element("body");
    body.isConnected = true;
    const document = {
        body,
        createElement: element,
        createElementNS: (_namespace, tagName) => element(tagName),
        getElementById(id) {
            return elements.find(item => item.id === id && item.isConnected) ?? null;
        }
    };
    const fetchImpl = async url => {
        if (url === "/api/auth/session") {
            return { ok: true, status: 200, json: async () => ({}) };
        }
        messageRequests++;
        messageUrls.push(url);
        return await new Promise(resolve => { pending.push(resolve); });
    };
    const globals = {
        document,
        URL: urls,
        URLSearchParams,
        TextEncoder,
        window: {
            location: { origin: "https://chatgpt.com", pathname: "/c/" + ID },
            sessionStorage: {
                getItem: key => browserSession.has(key) ? browserSession.get(key) : null,
                setItem: (key, value) => browserSession.set(key, String(value))
            }
        },
        Blob,
        AbortController,
        performance: clock,
        setTimeout: cb => setImmediate(cb),
        clearTimeout: clearImmediate,
        console: { info() {}, warn() {} },
        GM_registerMenuCommand() {},
        fetch: fetchImpl
    };
    if (storage) {
        const get = (key, defaultValue) =>
            storage.has(key) ? storage.get(key) : defaultValue;
        const set = (key, value) =>
            storage.set(key, JSON.parse(JSON.stringify(value)));
        if (useAsyncStorage) {
            globals.GM = {
                getValue: async (key, defaultValue) => get(key, defaultValue),
                setValue: async (key, value) => set(key, value)
            };
        } else {
            globals.GM_getValue = get;
            globals.GM_setValue = set;
        }
    }
    vm.runInNewContext(code, globals);
    const launcher = document.getElementById("chatgpt-conversation-export-launcher");
    const spinner = document.getElementById("chatgpt-conversation-export-spinner");
    const modeButton = () =>
        document.getElementById("chatgpt-conversation-export-mode-button");
    const toolbar = () =>
        document.getElementById("chatgpt-conversation-export-toolbar");
    const customTurns = () =>
        document.getElementById("chatgpt-conversation-export-custom-turns");
    const customDelay = () =>
        document.getElementById("chatgpt-conversation-export-custom-delay");
    const findButton = name => elements.filter(e =>
        e.tagName === "button" && e.textContent === name && e.isConnected
    ).at(-1);
    const visiblePanel = () => elements.find(e =>
        e.tagName === "aside" && e.isConnected
    ) ?? null;
    const settle = () => new Promise(resolve => setImmediate(resolve));
    return {
        launcher, spinner, pending, findButton, modeButton, toolbar, customTurns,
        customDelay, visiblePanel, settle, browserSession, messageUrls,
        get messageRequests() { return messageRequests; }
    };
}

test("Close hides progress until explicitly reopened and never cancels active work", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.messageRequests, 1);
    assert.ok(ui.visiblePanel());
    const cancel = ui.findButton("Cancel");
    assert.equal(cancel.disabled, false);

    ui.findButton("Close").listeners.click();
    assert.equal(ui.visiblePanel(), null);
    ui.pending[0](ok(page([msg("n1")], "cursor-end", false)));
    await ui.settle();
    await ui.settle();
    // Progress/completion were delivered, but the dismissed panel stays hidden.
    assert.equal(ui.visiblePanel(), null);
    assert.equal(ui.messageRequests, 1);
});

test("reopening a dismissed running export restores progress and enabled Cancel", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.messageRequests, 1);
    ui.findButton("Close").listeners.click();

    ui.pending[0](ok(page([msg("n2")], "cursor-next", true)));
    await ui.settle();
    await ui.settle();
    assert.equal(ui.visiblePanel(), null);
    assert.equal(ui.messageRequests, 2);

    // Clicking the launcher during a running export shows the same
    // session, retains its latest progress, and does not start new requests.
    ui.launcher.listeners.click();
    assert.ok(ui.visiblePanel());
    const cancel = ui.findButton("Cancel");
    assert.equal(cancel.disabled, false);
    assert.equal(cancel.style.opacity, "1");
    assert.equal(cancel.attributes["aria-disabled"], "false");
    const progress = ui.visiblePanel().children.find(node =>
        typeof node.textContent === "string" && node.textContent.includes("API pages")
    );
    assert.match(progress.textContent, /1 API pages, 1 message records/);
    assert.equal(ui.messageRequests, 2);

    // Completion after reopening must replace Cancel with the profile action.
    ui.pending[1](ok(page([msg("n1")], "cursor-oldest", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(cancel.hidden, true);
    assert.equal(cancel.style.display, "none");
    assert.equal(ui.findButton("Save performance report").hidden, false);
});


test("native ZIP contains byte-exact JSON and a verifiable CRC-32", async () => {
    const { crc32, compressJsonAsZipOrPlain } = require("../src/compression.js");
    const { inflateRawSync } = require("node:zlib");
    const json = JSON.stringify({ text: "Grüße 🎵", messages: ["hello".repeat(400)] });
    const filename = "chatgpt-conversation-" + ID + ".json";
    const result = await compressJsonAsZipOrPlain(json, filename, {
        CompressionStream,
        Response
    });
    assert.equal(result.format, "zip");
    assert.equal(result.fileName, filename.replace(/\.json$/, ".zip"));
    assert.equal(result.warning, null);
    assert.ok(result.archiveBytes < result.jsonBytes);

    const zip = Buffer.from(await result.blob.arrayBuffer());
    assert.equal(zip.readUInt32LE(0), 0x04034b50);
    assert.equal(zip.readUInt16LE(8), 8); // DEFLATE
    assert.equal(zip.readUInt16LE(6), 0x0800); // UTF-8 entry name
    const checksum = zip.readUInt32LE(14);
    const compressedSize = zip.readUInt32LE(18);
    const originalSize = zip.readUInt32LE(22);
    const fileNameLength = zip.readUInt16LE(26);
    assert.equal(zip.subarray(30, 30 + fileNameLength).toString(), filename);

    const deflate = zip.subarray(30 + fileNameLength,
        30 + fileNameLength + compressedSize);
    const unpacked = inflateRawSync(deflate);
    assert.equal(unpacked.length, originalSize);
    assert.equal(unpacked.toString("utf8"), json);
    assert.equal(checksum, crc32(unpacked));

    const central = 30 + fileNameLength + compressedSize;
    assert.equal(zip.readUInt32LE(central), 0x02014b50);
    assert.equal(zip.readUInt32LE(central + 16), checksum);
    assert.equal(zip.readUInt32LE(central + 42), 0);
    const eocd = central + 46 + fileNameLength;
    assert.equal(zip.readUInt32LE(eocd), 0x06054b50);
    assert.equal(zip.readUInt32LE(eocd + 12), 46 + fileNameLength);
    assert.equal(zip.readUInt32LE(eocd + 16), central);
});

test("missing CompressionStream saves honest plain JSON fallback", async () => {
    const { compressJsonAsZipOrPlain } = require("../src/compression.js");
    const source = '{"test":true}';
    const result = await compressJsonAsZipOrPlain(source, "test.json", {
        CompressionStream: null
    });
    assert.equal(result.fileName, "test.json");
    assert.equal(result.format, "json");
    assert.match(result.warning, /ZIP unavailable/);
    assert.equal(await result.blob.text(), source);
});

test("performance report action is hidden until the export settles successfully", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    const performance = ui.findButton("Save performance report");
    assert.ok(performance);
    const cancel = ui.findButton("Cancel");
    assert.equal(cancel.hidden, false);
    assert.equal(cancel.style.display, "");
    assert.equal(performance.hidden, true);
    assert.equal(performance.style.display, "none");

    ui.pending[0](ok(page([msg("single")], "cursor-end", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(performance.hidden, false);
    assert.equal(performance.style.display, "");
    assert.equal(performance.disabled, false);
    assert.equal(cancel.hidden, true);
    assert.equal(cancel.style.display, "none");
});

test("performance report action appears after export error without completed pages", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    const performance = ui.findButton("Save performance report");
    const cancel = ui.findButton("Cancel");
    assert.equal(cancel.hidden, false);
    assert.equal(performance.hidden, true);
    ui.pending[0]({ ok: false, status: 403 });
    await ui.settle();
    await ui.settle();
    assert.equal(performance.hidden, false);
    assert.equal(performance.disabled, false);
    assert.equal(cancel.hidden, true);
    assert.equal(cancel.style.display, "none");
});


test("launcher spinner remains active with progress panel closed and resets on success", async () => {
    const ui = makeExportUiHarness();
    assert.ok(ui.spinner);
    assert.equal(ui.spinner.style.display, "none");
    assert.equal(ui.launcher.attributes["aria-busy"], "false");
    assert.equal(ui.spinner.children.length, 3);
    assert.deepEqual(Array.from(ui.spinner.children, dot => dot.style.animationDelay),
        ["0ms", "150ms", "300ms"]);
    for (const dot of ui.spinner.children) {
        assert.equal(dot.style.background, "currentColor");
        assert.match(dot.style.animation, /dot-bounce 900ms ease-in-out infinite/);
    }
    assert.equal(ui.spinner.attributes["aria-hidden"], "true");

    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.spinner.style.display, "inline-flex");
    assert.equal(ui.launcher.attributes["aria-busy"], "true");
    assert.equal(ui.messageRequests, 1);

    ui.findButton("Close").listeners.click();
    assert.equal(ui.visiblePanel(), null);
    assert.equal(ui.spinner.style.display, "inline-flex");

    ui.pending[0](ok(page([msg("first")], "newer", true)));
    await ui.settle();
    await ui.settle();
    assert.equal(ui.visiblePanel(), null);
    assert.equal(ui.spinner.style.display, "inline-flex");
    assert.equal(ui.messageRequests, 2);

    // Reopening only the progress panel does not start a new export.
    ui.launcher.listeners.click();
    assert.equal(ui.messageRequests, 2);
    assert.equal(ui.spinner.style.display, "inline-flex");
    assert.equal(ui.findButton("Cancel").disabled, false);

    ui.findButton("Close").listeners.click();
    ui.pending[1](ok(page([msg("last")], "oldest", false)));
    await ui.settle();
    await ui.settle();

    assert.equal(ui.spinner.style.display, "none");
    assert.equal(ui.launcher.attributes["aria-busy"], "false");
    assert.equal(ui.visiblePanel(), null);
});

test("launcher spinner resets on HTTP error and when export is restarted", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.spinner.style.display, "inline-flex");

    ui.pending[0]({ ok: false, status: 403 });
    await ui.settle();
    await ui.settle();
    assert.equal(ui.spinner.style.display, "none");
    assert.equal(ui.launcher.attributes["aria-busy"], "false");
    assert.equal(ui.findButton("Save performance report").hidden, false);
    assert.equal(ui.findButton("Cancel").hidden, true);

    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.findButton("Save performance report").hidden, true);
    assert.equal(ui.findButton("Cancel").hidden, false);
    assert.equal(ui.spinner.style.display, "inline-flex");
    assert.equal(ui.messageRequests, 2);

    ui.pending[1](ok(page([msg("recovered")], "done", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(ui.spinner.style.display, "none");
});

test("launcher spinner stops after user cancellation even when panel was dismissed", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.spinner.style.display, "inline-flex");

    const cancel = ui.findButton("Cancel");
    ui.findButton("Close").listeners.click();
    cancel.listeners.click();
    await ui.settle();
    await ui.settle();

    // Existing mock network fetch doesn't observe the AbortSignal. The
    // core still checks cancellation as soon as the request resolves.
    ui.pending[0](ok(page([msg("cancelled")], "last", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(ui.spinner.style.display, "none");
    assert.equal(ui.launcher.attributes["aria-busy"], "false");
    assert.equal(ui.visiblePanel(), null);
});


test("Cancel is replaced by Save performance report after user cancellation", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    const cancel = ui.findButton("Cancel");
    const performance = ui.findButton("Save performance report");
    assert.equal(cancel.hidden, false);
    assert.equal(performance.hidden, true);

    cancel.listeners.click();
    ui.pending[0](ok(page([msg("interrupted")], "cursor-end", false)));
    await ui.settle();
    await ui.settle();

    assert.equal(cancel.hidden, true);
    assert.equal(cancel.style.display, "none");
    assert.equal(performance.hidden, false);
    assert.equal(performance.style.display, "");
    assert.equal(performance.disabled, false);
});

test("reopened running export retains Cancel and keeps performance report hidden", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    ui.findButton("Close").listeners.click();
    assert.equal(ui.visiblePanel(), null);

    ui.launcher.listeners.click();
    const panel = ui.visiblePanel();
    assert.ok(panel);
    const cancel = ui.findButton("Cancel");
    const performance = ui.findButton("Save performance report");
    assert.equal(cancel.hidden, false);
    assert.equal(cancel.disabled, false);
    assert.equal(performance.hidden, true);
    assert.equal(performance.style.display, "none");
    assert.equal(ui.messageRequests, 1);

    ui.pending[0]({ ok: false, status: 403 });
    await ui.settle();
    await ui.settle();
    assert.equal(cancel.hidden, true);
    assert.equal(performance.hidden, false);
});


test("two-turn batches reduce requests while retaining cursor order and validated output", async () => {
    const urls = [];
    const delays = [];
    const fetchImpl = async url => {
        if (url === "/api/auth/session") return ok({});
        urls.push(url);
        const q = new URL(url, "https://chatgpt.com").searchParams;
        assert.equal(q.get("num_turns"), "2");
        if (!q.has("before")) {
            return ok(page([msg("newer"), msg("middle")], "cursor-fast", true));
        }
        assert.equal(q.get("before"), "cursor-fast");
        return ok(page([msg("older")], "cursor-oldest", false));
    };
    const exporter = session(fetchImpl, {
        numTurns: 2,
        requestDelayMs: 100,
        sleep: async ms => delays.push(ms)
    });
    const output = await exporter.run();
    assert.deepEqual(output.messages.map(m => m.id), ["older", "newer", "middle"]);
    assert.equal(output.local_export_audit.pagination_verified, true);
    assert.equal(output.local_export_audit.pages_loaded, 2);
    assert.equal(urls.length, 2);
    assert.deepEqual(delays, [100]);
    assert.equal(exporter.snapshot().effectiveNumTurns, 2);
});

test("fast batches fall back to proven 1-turn requests after repeated 5xx", async () => {
    const calls = [];
    const delays = [];
    const fetchImpl = async url => {
        if (url === "/api/auth/session") return ok({});
        const q = new URL(url, "https://chatgpt.com").searchParams;
        calls.push({ turns: q.get("num_turns"), before: q.get("before") });
        if (!q.has("before")) return ok(page([msg("new")], "cursor-new", true));
        if (q.get("num_turns") === "2") return fail(503);
        return ok(page([msg("old")], "cursor-end", false));
    };
    const exporter = session(fetchImpl, {
        numTurns: 2,
        requestDelayMs: 100,
        sleep: async ms => delays.push(ms)
    });
    const output = await exporter.run();
    assert.deepEqual(calls.map(x => x.turns), ["2", "2", "2", "1"]);
    assert.equal(calls[1].before, "cursor-new");
    assert.equal(calls[3].before, "cursor-new");
    assert.equal(exporter.snapshot().effectiveNumTurns, 1);
    assert.equal(exporter.snapshot().fallbackCount, 1);
    assert.deepEqual(output.messages.map(m => m.id), ["old", "new"]);
    assert.equal(output.local_export_audit.pagination_verified, true);
    assert.deepEqual(delays, [100, 1500, 3000]);
});

test("rate limiting never triggers batch-size downgrade", async () => {
    let failures = 2;
    const seenTurns = [];
    const fetchImpl = async url => {
        if (url === "/api/auth/session") return ok({});
        const turns = new URL(url, "https://chatgpt.com").searchParams.get("num_turns");
        seenTurns.push(turns);
        if (failures-- > 0) return fail(429);
        return ok(page([msg("one")], "end", false));
    };
    const exporter = session(fetchImpl, { numTurns: 2 });
    const output = await exporter.run();
    assert.equal(output.messages.length, 1);
    assert.deepEqual(seenTurns, ["2", "2", "2"]);
    assert.equal(exporter.snapshot().effectiveNumTurns, 2);
    assert.equal(exporter.snapshot().fallbackCount, 0);
});

test("completed export re-run after Close leaves no greyed-out Cancel button", async () => {
    const ui = makeExportUiHarness();
    ui.launcher.listeners.click();
    await ui.settle();
    ui.pending[0](ok(page([msg("a")], "last", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(ui.findButton("Cancel").hidden, true);
    assert.equal(ui.findButton("Save performance report").hidden, false);

    ui.findButton("Close").listeners.click();
    assert.equal(ui.visiblePanel(), null);
    ui.launcher.listeners.click();
    await ui.settle();
    await ui.settle();

    assert.equal(ui.messageRequests, 1, "completed session should not refetch backend");
    assert.ok(ui.visiblePanel());
    const cancel = ui.findButton("Cancel");
    assert.ok(cancel);
    assert.equal(cancel.hidden, true);
    assert.equal(cancel.style.display, "none");
    const save = ui.findButton("Save performance report");
    assert.equal(save.hidden, false);
    assert.equal(save.style.display, "");
    assert.equal(ui.spinner.style.display, "none");
    assert.equal(ui.launcher.attributes["aria-busy"], "false");
});


test("performance diagnostics track batch sizes and pacing without retaining any URL or cursor", async () => {
    const { createExportProfiler } = require("../src/profiling.js");
    let tick = 0;
    const profiler = createExportProfiler({ now: () => tick });
    const instrument = profiler.instrumentFetch(async (_url, _options) => {
        tick += 12;
        return {
            ok: true, status: 200,
            json: async () => { tick += 3; return { messages: [] }; }
        };
    }, () => 1);
    const secret = "/backend-api/conversations/" + ID +
        "/messages?include_has_versions=true&num_turns=2&before=private-cursor";
    const response = await instrument(secret, {
        headers: { Authorization: "Bearer private-token" }
    });
    await response.json();
    profiler.trackPage({ pages: 1, records: 17, requestDelayMs: 100 });
    const report = profiler.report();
    assert.equal(report.summary.request_delay_ms, 100);
    assert.equal(report.summary.requests_by_num_turns["2"], 1);
    assert.equal(report.requests[0].num_turns, 2);
    assert.equal(report.pages[0].num_turns, 2);
    assert.equal(report.pages[0].request_delay_ms, 100);
    const json = JSON.stringify(report);
    for (const sensitive of [ID, "private-cursor", "private-token"]) {
        assert.equal(json.includes(sensitive), false);
    }
});


test("Dots animation is local CSS with reduced-motion fallback, no rotating ring", () => {
    const entry = fs.readFileSync(path.join(
        __dirname, "../src/userscript-entry.js"
    ), "utf8");
    assert.match(entry, /@keyframes chatgpt-conversation-export-dot-bounce/);
    assert.match(entry, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(entry, /animation: none !important/);
    assert.match(entry, /index \* 150 \+ "ms"/);
    assert.doesNotMatch(entry, /chatgpt-conversation-export-spin[ "]|rotate\(360deg\)/);
});


test("v0.2.0 compact launcher has an adjacent gear and only two numeric settings", async () => {
    const ui = makeExportUiHarness();
    await ui.settle();
    const toolbar = ui.toolbar();
    assert.ok(toolbar);
    assert.equal(toolbar.children[0], ui.launcher);
    assert.equal(toolbar.children[1], ui.modeButton());
    assert.equal(ui.launcher.style.font, "11px/1.3 system-ui, sans-serif");
    assert.equal(ui.launcher.style.padding, "6px 9px");
    const settings = ui.modeButton();
    assert.equal(settings.textContent, undefined, "no ship-wheel glyph");
    assert.equal(settings.style.background, "transparent");
    assert.equal(settings.style.border, "0");
    assert.equal(settings.style.boxShadow, "none");
    assert.equal(settings.style.color, "inherit");
    assert.equal(ui.toolbar().style.color,
        "var(--text-primary, var(--token-text-primary, inherit))");
    const svg = settings.children[0];
    assert.equal(svg.tagName, "svg");
    assert.equal(svg.attributes.viewBox, "0 0 24 24");
    assert.equal(svg.attributes.fill, "currentColor");
    assert.equal(svg.attributes["aria-hidden"], "true");
    assert.equal(svg.children[0].tagName, "path");
    assert.equal(svg.children[0].attributes["fill-rule"], "evenodd");
    assert.match(svg.children[0].attributes.d, /M 15 12 A 3 3/);
    assert.equal(settings.attributes["aria-label"],
        "Export performance settings");
    ui.modeButton().listeners.click();
    assert.equal(ui.customTurns().value, "3");
    assert.equal(ui.customDelay().value, "100");
    assert.equal(ui.findButton("Save").disabled, false);
    assert.ok(ui.findButton("Load defaults"));
    assert.equal(ui.modeSelect, undefined, "no presets/dropdown");
    assert.ok(ui.visiblePanel());
});

test("session-only edits affect next API request without saving persistently", async () => {
    const durable = new Map();
    const session = new Map();
    const ui = makeExportUiHarness(durable, false, session);
    await ui.settle();
    ui.modeButton().listeners.click();
    ui.customTurns().value = "12";
    ui.customTurns().listeners.input();
    ui.customDelay().value = "650";
    ui.customDelay().listeners.change();
    assert.equal(durable.size, 0, "editing never calls GM_setValue");
    const ephemeral = JSON.parse(session.get(
        "chatgpt-conversation-exporter.session-settings.v2"));
    assert.deepEqual(ephemeral, { numTurns: 12, delay: 650 });
    ui.launcher.listeners.click();
    await ui.settle();
    assert.match(ui.messageUrls[0], /num_turns=12/);
    ui.pending[0](ok(page([msg("finished")], "end", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(durable.size, 0);

    const reloaded = makeExportUiHarness(durable, false, session);
    await reloaded.settle();
    reloaded.modeButton().listeners.click();
    assert.equal(reloaded.customTurns().value, "12");
    assert.equal(reloaded.customDelay().value, "650");
    const newBrowserSession = makeExportUiHarness(durable, false, new Map());
    await newBrowserSession.settle();
    newBrowserSession.modeButton().listeners.click();
    assert.equal(newBrowserSession.customTurns().value, "3");
    assert.equal(newBrowserSession.customDelay().value, "100");
});

test("Save commits values to userscript storage for future sessions", async () => {
    const durable = new Map();
    const session = new Map();
    const ui = makeExportUiHarness(durable, false, session);
    await ui.settle();
    ui.modeButton().listeners.click();
    ui.customTurns().value = "25";
    ui.customTurns().listeners.change();
    ui.customDelay().value = "300";
    ui.customDelay().listeners.change();
    assert.equal(durable.size, 0);
    ui.findButton("Save").listeners.click();
    await ui.settle();
    await ui.settle();
    assert.deepEqual(durable.get("chatgpt-conversation-exporter.settings.v2"),
        { numTurns: 25, delay: 300 });
    const nextSession = makeExportUiHarness(durable, false, new Map());
    await nextSession.settle();
    nextSession.modeButton().listeners.click();
    assert.equal(nextSession.customTurns().value, "25");
    assert.equal(nextSession.customDelay().value, "300");
});

test("Load defaults changes session only; Save afterward persists defaults", async () => {
    const key = "chatgpt-conversation-exporter.settings.v2";
    const durable = new Map([[key, { numTurns: 6, delay: 333 }]]);
    const session = new Map();
    const ui = makeExportUiHarness(durable, false, session);
    await ui.settle();
    ui.modeButton().listeners.click();
    assert.equal(ui.customTurns().value, "6");
    ui.findButton("Load defaults").listeners.click();
    assert.equal(ui.customTurns().value, "3");
    assert.equal(ui.customDelay().value, "100");
    assert.deepEqual(durable.get(key), { numTurns: 6, delay: 333 });
    const reloaded = makeExportUiHarness(durable, false, session);
    await reloaded.settle();
    reloaded.modeButton().listeners.click();
    assert.equal(reloaded.customTurns().value, "3");
    ui.findButton("Save").listeners.click();
    await ui.settle();
    await ui.settle();
    assert.deepEqual(durable.get(key), { numTurns: 3, delay: 100 });
    const freshSession = makeExportUiHarness(durable);
    await freshSession.settle();
    freshSession.modeButton().listeners.click();
    assert.equal(freshSession.customTurns().value, "3");
});

test("legacy v0.1.12 stored presets are migrated without writing on load", async () => {
    const durable = new Map([[
        "chatgpt-conversation-exporter.settings.v1",
        { mode: "custom", customNumTurns: 7, customDelayMs: 480 }
    ]]);
    const ui = makeExportUiHarness(durable, false, new Map());
    await ui.settle();
    ui.modeButton().listeners.click();
    assert.equal(ui.customTurns().value, "7");
    assert.equal(ui.customDelay().value, "480");
    assert.equal(durable.has("chatgpt-conversation-exporter.settings.v2"),
        false, "read-only migration until explicit Save");
});

test("asynchronous Greasemonkey reads restore values before requests", async () => {
    const durable = new Map([[
        "chatgpt-conversation-exporter.settings.v2",
        { numTurns: 8, delay: 800 }
    ]]);
    const ui = makeExportUiHarness(durable, true, new Map());
    ui.launcher.listeners.click();
    await ui.settle();
    assert.equal(ui.messageRequests, 1);
    assert.match(ui.messageUrls[0], /num_turns=8/);
    ui.pending[0](ok(page([msg("last")], "end", false)));
    await ui.settle();
    await ui.settle();
});

test("custom settings cannot change during export and re-enable after completion", async () => {
    const ui = makeExportUiHarness(new Map());
    ui.launcher.listeners.click();
    await ui.settle();
    ui.modeButton().listeners.click();
    assert.equal(ui.customTurns().disabled, true);
    assert.equal(ui.customDelay().disabled, true);
    assert.equal(ui.findButton("Save").disabled, true);
    ui.customTurns().value = "25";
    ui.customTurns().listeners.input();
    assert.equal(ui.customTurns().value, "3");
    ui.pending[0](ok(page([msg("last")], "end", false)));
    await ui.settle();
    await ui.settle();
    assert.equal(ui.customTurns().disabled, false);
    assert.equal(ui.findButton("Save").disabled, false);
});

test("invalid values do not alter current configuration or permanent storage", async () => {
    const durable = new Map();
    const ui = makeExportUiHarness(durable);
    await ui.settle();
    ui.modeButton().listeners.click();
    for (const [turns, delay] of [
        ["0", "100"], ["1001", "100"], ["2.5", "100"],
        ["2", "-1"], ["2", "60001"], ["2", ""]
    ]) {
        ui.customTurns().value = turns;
        ui.customDelay().value = delay;
        ui.findButton("Save").listeners.click();
        await ui.settle();
        assert.equal(durable.size, 0, "invalid edits may not be saved");
    }
    ui.customTurns().value = "4";
    ui.customDelay().value = "0";
    ui.customDelay().listeners.change();
    assert.equal(durable.size, 0);
    ui.launcher.listeners.click();
    await ui.settle();
    assert.match(ui.messageUrls[0], /num_turns=4/);
    ui.pending[0](ok(page([msg("one")], "end", false)));
    await ui.settle();
    await ui.settle();
});

test("rapid Greasemonkey Save clicks serialize and persist last values", async () => {
    const durable = new Map();
    const ui = makeExportUiHarness(durable, true);
    await ui.settle();
    ui.modeButton().listeners.click();
    ui.customTurns().value = "4";
    ui.findButton("Save").listeners.click();
    ui.customTurns().value = "5";
    ui.findButton("Save").listeners.click();
    await ui.settle();
    await ui.settle();
    await ui.settle();
    assert.deepEqual(durable.get("chatgpt-conversation-exporter.settings.v2"),
        { numTurns: 5, delay: 100 });
});

test("export core supports configurable batches higher than three", async () => {
    const urls = [];
    const exporter = session(async url => {
        if (url === "/api/auth/session") return ok({});
        urls.push(url);
        return ok(page([msg("one")], "end", false));
    }, { numTurns: 16, requestDelayMs: 0 });
    const result = await exporter.run();
    assert.equal(result.local_export_audit.pagination_verified, true);
    assert.match(urls[0], /num_turns=16/);
    assert.throws(() => session(async () => ok({}),
        { numTurns: 1001 }), /numTurns/);
});


test("theme-aware gear has no filled button chrome, keeps keyboard focus and Dots untouched", () => {
    const entry = fs.readFileSync(path.join(__dirname, "../src/userscript-entry.js"), "utf8");
    assert.match(entry, /color: "var\(--text-primary, var\(--token-text-primary, inherit\)\)"/);
    assert.match(entry, /background: "transparent", color: "inherit"/);
    assert.match(entry, /document\.createElementNS\(svgNS, "svg"\)/);
    assert.match(entry, /focus-visible/);
    assert.match(entry, /setAttribute\("aria-label", settings\.title\)/);
    assert.doesNotMatch(entry, /settings\.textContent = "⚙"/);
    assert.match(entry, /chatgpt-conversation-export-dot-bounce/);
});


test("export completion displays cumulative active duration and both uncompressed and saved sizes", async () => {
    let currentMs = 0;
    const ui = makeExportUiHarness(null, false, new Map(),
        { now: () => currentMs });
    ui.launcher.listeners.click();
    await ui.settle();
    currentMs = 125432;
    ui.pending[0](ok(page([msg("last")], "end", false)));
    await ui.settle();
    await ui.settle();
    const panel = ui.visiblePanel();
    assert.ok(panel);
    assert.equal(panel.children[1].textContent,
        "Export complete – JSON download started.");
    assert.match(panel.children[2].textContent,
        /1 API pages, 1 unique message records;/);
    assert.match(panel.children[2].textContent,
        /Duration: 2m 5\.4s \(active\)/);
    assert.match(panel.children[2].textContent,
        /JSON uncompressed: \d+\.\d{2} MiB;/);
    assert.match(panel.children[2].textContent,
        /JSON \d+\.\d{2} MiB/);
    assert.match(panel.children[2].textContent, /\.json/);
});

test("profiler completion duration includes resumed active runs but excludes paused time", () => {
    const { createExportProfiler } = require("../src/profiling.js");
    let currentMs = 100;
    const profiler = createExportProfiler({ now: () => currentMs });
    const first = profiler.runStarted();
    currentMs += 4500;
    assert.equal(profiler.activeElapsedMs(first), 4500);
    profiler.runEnded(first);
    currentMs += 60000; // user stopped export; do not count wall-clock pause
    const resumed = profiler.runStarted();
    currentMs += 65300;
    assert.equal(profiler.activeElapsedMs(resumed), 69800);
    // The method is an observation; it does not finalize/double-count.
    assert.equal(profiler.report().summary.active_run_ms, 4500);
    profiler.runEnded(resumed);
    assert.equal(profiler.report().summary.active_run_ms, 69800);
});
