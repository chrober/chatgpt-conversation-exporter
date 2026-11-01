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
    const zipSupported = options.CompressionStream ??
        (typeof CompressionStream !== "undefined" ? CompressionStream : null);
    const responseFactory = options.Response ??
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
