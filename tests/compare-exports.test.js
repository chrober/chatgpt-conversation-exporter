"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const zlib = require("node:zlib");
const { encodeZipSingleFile } = require("../src/compression.js");
const { decodeSingleFileZip, readExport, compareExports, cli } =
    require("../scripts/compare-exports.js");

const m = (id, value) => ({
    id, author: { role: "assistant" }, content: { parts: [value] },
    metadata: { nested: { alpha: 1, beta: 2 } }
});
const doc = (messages, pages) => ({
    messages,
    page_metadata: Array.from({ length: pages }, (_, i) => ({ page: i + 1 })),
    local_export_audit: {
        pagination_verified: true, pages_loaded: pages,
        exported_at: new Date().toISOString()
    }
});

test("offline comparator accepts different metadata and key order with equal messages", () => {
    const a = doc([m("a", "🎶"), m("b", "original")], 4);
    const b = doc([
        { ...m("a", "🎶"), metadata: { nested: { beta: 2, alpha: 1 } } },
        m("b", "original")
    ], 2);
    const x = compareExports(a, b);
    assert.equal(x.verdict, "identical");
    assert.equal(x.message_order_identical, true);
    assert.equal(x.same_id_different_content, 0);
    assert.equal(x.only_in_left, 0);
    assert.equal(x.only_in_right, 0);
});

test("offline comparator reports anonymous missing, altered and reordered records", () => {
    const base = doc([m("a", "A"), m("b", "B")], 1);
    const changed = doc([m("b", "DIFFERENT"), m("c", "C")], 1);
    const x = compareExports(base, changed);
    assert.equal(x.verdict, "different");
    assert.equal(x.only_in_left, 1);
    assert.equal(x.only_in_right, 1);
    assert.equal(x.same_id_different_content, 1);
    assert.equal(x.message_order_identical, false);
    assert.equal(JSON.stringify(x).includes("DIFFERENT"), false);
    const rearranged = compareExports(base, doc([m("b", "B"), m("a", "A")], 3));
    assert.equal(rearranged.only_in_left, 0);
    assert.equal(rearranged.same_id_different_content, 0);
    assert.equal(rearranged.message_order_identical, false);
});

test("offline comparator rejects duplicate message IDs", () => {
    const x = compareExports(doc([m("a", "A"), m("a", "A")], 1),
        doc([m("a", "A")], 1));
    assert.equal(x.verdict, "different");
    assert.equal(x.left_duplicate_ids, 1);
});

test("offline comparator reads and CRC-validates generated single-entry ZIP", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-compare-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const oldFile = path.join(dir, "old.json");
    const zipFile = path.join(dir, "new.zip");
    const content = JSON.stringify(doc([m("a", "Ä🎵".repeat(100))], 3));
    fs.writeFileSync(oldFile, content);
    const bytes = Buffer.from(content);
    const zip = encodeZipSingleFile("chat.json", bytes, zlib.deflateRawSync(bytes));
    fs.writeFileSync(zipFile, Buffer.from(await zip.arrayBuffer()));

    assert.equal(decodeSingleFileZip(fs.readFileSync(zipFile)).toString("utf8"), content);
    assert.equal(readExport(zipFile).messages.length, 1);
    const logs = [], errors = [];
    const exit = cli([oldFile, zipFile], {
        log: msg => logs.push(msg), error: msg => errors.push(msg)
    });
    assert.equal(exit, 0);
    assert.equal(errors.length, 0);
    assert.equal(JSON.parse(logs[0]).verdict, "identical");

    const corrupted = fs.readFileSync(zipFile);
    corrupted[35] ^= 1;
    assert.throws(() => decodeSingleFileZip(corrupted));
});

test("offline comparator rejects incomplete exports and unsafe ZIP entry paths", async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-compare-"));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const incomplete = path.join(dir, "partial.json");
    fs.writeFileSync(incomplete, JSON.stringify({ messages: [m("a", "A")] }));
    assert.throws(() => readExport(incomplete), /complete/);

    const source = Buffer.from(JSON.stringify(doc([m("a", "A")], 1)));
    const unsafeZip = encodeZipSingleFile("../private.json", source,
        zlib.deflateRawSync(source));
    const archive = Buffer.from(await unsafeZip.arrayBuffer());
    assert.throws(() => decodeSingleFileZip(archive), /plain-name/);
});
