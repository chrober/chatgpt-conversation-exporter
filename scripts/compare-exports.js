"use strict";

// Local-only JSON/ZIP equality check. Never sends data over the network and
// never prints conversation IDs, message IDs or message content.
const fs = require("node:fs");
const zlib = require("node:zlib");
const crypto = require("node:crypto");
const path = require("node:path");

const MAX_JSON_BYTES = 256 * 1024 * 1024;
const ZIP_END = 0x06054b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) {
        crc ^= byte;
        for (let bit = 0; bit < 8; bit++) {
            crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
    }
    return (crc ^ 0xffffffff) >>> 0;
}

function decodeSingleFileZip(input) {
    if (input.length < 22 || input.readUInt32LE(0) !== ZIP_LOCAL) {
        throw new Error("Invalid ZIP: local file header missing.");
    }
    // End of Central Directory may contain an optional comment.
    let end = -1;
    for (let offset = input.length - 22; offset >= Math.max(0, input.length - 22 - 65535); offset--) {
        if (input.readUInt32LE(offset) === ZIP_END &&
            offset + 22 + input.readUInt16LE(offset + 20) === input.length) {
            end = offset;
            break;
        }
    }
    if (end < 0) throw new Error("Invalid ZIP: central directory terminator missing.");
    if (input.readUInt16LE(end + 8) !== 1 ||
        input.readUInt16LE(end + 10) !== 1 ||
        input.readUInt16LE(end + 4) !== 0 ||
        input.readUInt16LE(end + 6) !== 0) {
        throw new Error("Expected one ZIP entry on a single disk.");
    }

    const centralOffset = input.readUInt32LE(end + 16);
    const centralSize = input.readUInt32LE(end + 12);
    if (centralSize < 46 || centralOffset + centralSize !== end ||
        centralOffset + 46 > input.length ||
        input.readUInt32LE(centralOffset) !== ZIP_CENTRAL) {
        throw new Error("Invalid ZIP central directory.");
    }
    const flags = input.readUInt16LE(centralOffset + 8);
    const method = input.readUInt16LE(centralOffset + 10);
    const checksum = input.readUInt32LE(centralOffset + 16);
    const packedSize = input.readUInt32LE(centralOffset + 20);
    const originalSize = input.readUInt32LE(centralOffset + 24);
    const nameLength = input.readUInt16LE(centralOffset + 28);
    const extraLength = input.readUInt16LE(centralOffset + 30);
    const commentLength = input.readUInt16LE(centralOffset + 32);
    const localOffset = input.readUInt32LE(centralOffset + 42);
    if ((flags & 0x0001) || ![0, 8].includes(method) ||
        [packedSize, originalSize, localOffset].includes(0xffffffff)) {
        throw new Error("Unsupported encrypted, ZIP64 or non-DEFLATE archive.");
    }
    if (originalSize > MAX_JSON_BYTES) {
        throw new Error("Decoded JSON exceeds the 256 MiB safety limit.");
    }
    if (centralOffset + 46 + nameLength + extraLength + commentLength !== end) {
        throw new Error("Invalid ZIP entry length.");
    }
    const entryName = input.subarray(centralOffset + 46, centralOffset + 46 + nameLength)
        .toString("utf8");
    if (!entryName.endsWith(".json") ||
        path.basename(entryName) !== entryName || entryName.includes("\\")) {
        throw new Error("ZIP must contain a single plain-name JSON file.");
    }

    if (localOffset + 30 > input.length || input.readUInt32LE(localOffset) !== ZIP_LOCAL ||
        input.readUInt16LE(localOffset + 8) !== method) {
        throw new Error("Invalid local ZIP entry header.");
    }
    const localNameLength = input.readUInt16LE(localOffset + 26);
    const localExtraLength = input.readUInt16LE(localOffset + 28);
    const localName = input.subarray(localOffset + 30, localOffset + 30 + localNameLength)
        .toString("utf8");
    if (localName !== entryName) throw new Error("ZIP entry names do not match.");
    const payloadStart = localOffset + 30 + localNameLength + localExtraLength;
    if (payloadStart + packedSize > centralOffset) {
        throw new Error("Invalid ZIP payload boundaries.");
    }
    const packed = input.subarray(payloadStart, payloadStart + packedSize);
    const bytes = method === 8 ?
        zlib.inflateRawSync(packed, { maxOutputLength: MAX_JSON_BYTES }) :
        Buffer.from(packed);
    if (bytes.length !== originalSize || crc32(bytes) !== checksum) {
        throw new Error("ZIP size or CRC32 verification failed.");
    }
    return bytes;
}


/**
 * Extract only the root conversation JSON from an attachment-enabled ZIP.
 * Other entries are deliberately outside message-content equivalence scope.
 * Bounds, local/central name matching and JSON CRC are always verified.
 */
function decodeConversationFromMultiZip(input) {
    let end = -1;
    for (let i = input.length - 22;
        i >= Math.max(0, input.length - 22 - 65535); i--) {
        if (input.readUInt32LE(i) === ZIP_END &&
            i + 22 + input.readUInt16LE(i + 20) === input.length) {
            end = i;
            break;
        }
    }
    if (end < 0 || input.readUInt16LE(end + 4) !== 0 ||
        input.readUInt16LE(end + 6) !== 0) {
        throw new Error("Invalid multi-entry ZIP end record.");
    }
    const count = input.readUInt16LE(end + 10);
    const start = input.readUInt32LE(end + 16);
    const size = input.readUInt32LE(end + 12);
    if (count < 1 || start + size !== end) {
        throw new Error("Invalid ZIP central directory size.");
    }
    let at = start, target = null;
    const seen = new Set();
    for (let i = 0; i < count; i++) {
        if (at + 46 > end || input.readUInt32LE(at) !== ZIP_CENTRAL) {
            throw new Error("Invalid ZIP central entry.");
        }
        const flags = input.readUInt16LE(at + 8);
        const method = input.readUInt16LE(at + 10);
        const crc = input.readUInt32LE(at + 16);
        const packedSize = input.readUInt32LE(at + 20);
        const rawSize = input.readUInt32LE(at + 24);
        const nameLen = input.readUInt16LE(at + 28);
        const extraLen = input.readUInt16LE(at + 30);
        const commentLen = input.readUInt16LE(at + 32);
        const local = input.readUInt32LE(at + 42);
        const next = at + 46 + nameLen + extraLen + commentLen;
        if (next > end || (flags & 1) || ![0, 8].includes(method) ||
            [packedSize, rawSize, local].includes(0xffffffff)) {
            throw new Error("Unsupported or corrupt ZIP entry.");
        }
        const name = input.subarray(at + 46, at + 46 + nameLen).toString("utf8");
        if (!name || name.startsWith("/") || name.includes("\\") ||
            name.split("/").includes("..") || seen.has(name)) {
            throw new Error("Unsafe or duplicate ZIP entry.");
        }
        seen.add(name);
        if (local + 30 > start || input.readUInt32LE(local) !== ZIP_LOCAL ||
            input.readUInt16LE(local + 8) !== method) {
            throw new Error("Invalid local ZIP header.");
        }
        const localNameLen = input.readUInt16LE(local + 26);
        const localExtraLen = input.readUInt16LE(local + 28);
        const localName = input.subarray(local + 30, local + 30 + localNameLen)
            .toString("utf8");
        const payload = local + 30 + localNameLen + localExtraLen;
        if (localName !== name || payload + packedSize > start) {
            throw new Error("Invalid local ZIP boundaries.");
        }
        if (/^chatgpt-conversation-[a-zA-Z0-9-]+\.json$/.test(name) ||
            (count === 1 && name.endsWith(".json") &&
                path.basename(name) === name)) {
            if (target) throw new Error("Multiple conversation JSON entries.");
            if (rawSize > MAX_JSON_BYTES) {
                throw new Error("Decoded JSON exceeds the 256 MiB safety limit.");
            }
            const packed = input.subarray(payload, payload + packedSize);
            const bytes = method === 8 ?
                zlib.inflateRawSync(packed, { maxOutputLength: MAX_JSON_BYTES }) :
                Buffer.from(packed);
            if (bytes.byteLength !== rawSize || crc32(bytes) !== crc) {
                throw new Error("Conversation JSON size or CRC32 mismatch.");
            }
            target = bytes;
        }
        at = next;
    }
    if (at !== end || !target) {
        throw new Error("ZIP has no valid root conversation JSON entry.");
    }
    return target;
}

function readExport(file) {
    const bytes = fs.readFileSync(file);
    let decoded;
    if (bytes.readUInt32LE(0) === ZIP_LOCAL) {
        decoded = decodeConversationFromMultiZip(bytes);
    } else {
        if (bytes.length > MAX_JSON_BYTES) {
            throw new Error("JSON exceeds the 256 MiB safety limit.");
        }
        decoded = bytes;
    }
    const data = JSON.parse(decoded.toString("utf8"));
    if (!data || !Array.isArray(data.messages) ||
        data.local_export_audit?.pagination_verified !== true) {
        throw new Error("Expected a complete chatgpt-paginated-conversation export.");
    }
    return data;
}

function stableJson(value) {
    if (Array.isArray(value)) return "[" + value.map(stableJson).join(",") + "]";
    if (value && typeof value === "object") {
        return "{" + Object.keys(value).sort()
            .map(k => JSON.stringify(k) + ":" + stableJson(value[k])).join(",") + "}";
    }
    return JSON.stringify(value);
}

function digest(value) {
    return crypto.createHash("sha256").update(stableJson(value)).digest("hex");
}

function indexMessages(data) {
    const byId = new Map();
    let duplicateIds = 0;
    for (const message of data.messages) {
        if (!message || typeof message.id !== "string" || !message.id) {
            throw new Error("Export contains a message without a valid ID.");
        }
        if (byId.has(message.id)) duplicateIds++;
        byId.set(message.id, digest(message));
    }
    return { byId, duplicateIds };
}

function compareExports(left, right) {
    const l = indexMessages(left), r = indexMessages(right);
    const onlyLeft = [...l.byId.keys()].filter(id => !r.byId.has(id)).length;
    const onlyRight = [...r.byId.keys()].filter(id => !l.byId.has(id)).length;
    const modified = [...l.byId].filter(([id, hash]) =>
        r.byId.has(id) && r.byId.get(id) !== hash
    ).length;
    const leftOrder = left.messages.map(x => x.id);
    const rightOrder = right.messages.map(x => x.id);
    const orderIdentical = leftOrder.length === rightOrder.length &&
        leftOrder.every((id, index) => id === rightOrder[index]);
    const exactMatch = onlyLeft === 0 && onlyRight === 0 &&
        modified === 0 && l.duplicateIds === 0 && r.duplicateIds === 0 &&
        orderIdentical;
    return {
        verdict: exactMatch ? "identical" : "different",
        left_message_records: left.messages.length,
        right_message_records: right.messages.length,
        left_duplicate_ids: l.duplicateIds,
        right_duplicate_ids: r.duplicateIds,
        only_in_left: onlyLeft,
        only_in_right: onlyRight,
        same_id_different_content: modified,
        message_order_identical: orderIdentical,
        // Root metadata and pagination layouts intentionally not compared.
        compared: "message IDs, complete message objects (canonical JSON), and message order"
    };
}

function cli(args, logger = console) {
    if (args.length !== 2) {
        logger.error("Usage: node scripts/compare-exports.js <baseline.json|zip> <candidate.json|zip>");
        return 2;
    }
    try {
        const report = compareExports(readExport(args[0]), readExport(args[1]));
        logger.log(JSON.stringify(report, null, 2));
        return report.verdict === "identical" ? 0 : 1;
    } catch (error) {
        logger.error("Could not compare exports: " + error.message);
        return 2;
    }
}

if (require.main === module) process.exitCode = cli(process.argv.slice(2));
module.exports = { decodeSingleFileZip, decodeConversationFromMultiZip, readExport, compareExports, cli };
