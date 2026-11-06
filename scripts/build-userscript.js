"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const core = fs.readFileSync(path.join(root, "src/exporter-core.js"), "utf8").trimEnd();
const entry = fs.readFileSync(path.join(root, "src/userscript-entry.js"), "utf8").trimEnd();
const profiling = fs.readFileSync(path.join(root, "src/profiling.js"), "utf8").trimEnd();
const compression = fs.readFileSync(path.join(root, "src/compression.js"), "utf8").trimEnd();
const attachments = fs.readFileSync(path.join(root, "src/attachments.js"), "utf8").trimEnd();
const target = path.join(root, "userscripts/chatgpt-conversation-export.user.js");
const metadataTarget = path.join(root, "userscripts/chatgpt-conversation-export.meta.js");
const version = require(path.join(root, "package.json")).version;
const stableBase = "https://raw.githubusercontent.com/chrober/" +
    "chatgpt-conversation-exporter/main/userscripts/chatgpt-conversation-export";

const metadata = [
    "// ==UserScript==",
    "// @name         ChatGPT Conversation Exporter",
    "// @namespace    https://github.com/chrober/chatgpt-conversation-exporter",
    "// @version      " + version,
    "// @author       Christoph O'Bermair",
    "// @description  Export the current ChatGPT conversation as JSON.",
    "// @match        https://chatgpt.com/*",
    "// @run-at       document-idle",
    "// @updateURL    " + stableBase + ".meta.js",
    "// @downloadURL  " + stableBase + ".user.js",
    "// @grant        GM_registerMenuCommand",
    "// @grant        GM.registerMenuCommand",
    "// @grant        GM_getValue",
    "// @grant        GM_setValue",
    "// @grant        GM.getValue",
    "// @grant        GM.setValue",
    "// ==/UserScript=="
].join("\n");
const metadataOutput = metadata + "\n";

const output = [
    metadata,
    "(function () {",
    core,
    profiling,
    compression,
    attachments,
    entry,
    "})();"
].join("\n\n") + "\n";

if (process.argv.includes("--check")) {
    let outdated = false;
    for (const [filename, expected] of [
        [target, output],
        [metadataTarget, metadataOutput]
    ]) {
        if (!fs.existsSync(filename) ||
            fs.readFileSync(filename, "utf8") !== expected) {
            console.error("Generated file is out of date:",
                path.relative(root, filename));
            outdated = true;
        }
    }
    if (outdated) process.exitCode = 1;
    else console.log("Userscript and update metadata are current.");
} else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
    fs.writeFileSync(metadataTarget, metadataOutput);
    console.log("Generated:", path.relative(root, target),
        "and", path.relative(root, metadataTarget));
}
