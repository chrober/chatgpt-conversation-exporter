"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const core = fs.readFileSync(path.join(root, "src/exporter-core.js"), "utf8").trimEnd();
const entry = fs.readFileSync(path.join(root, "src/userscript-entry.js"), "utf8").trimEnd();
const profiling = fs.readFileSync(path.join(root, "src/profiling.js"), "utf8").trimEnd();
const compression = fs.readFileSync(path.join(root, "src/compression.js"), "utf8").trimEnd();
const target = path.join(root, "userscripts/chatgpt-conversation-export.user.js");

const metadata = [
    "// ==UserScript==",
    "// @name         ChatGPT Conversation Exporter",
    "// @namespace    https://github.com/chrober/chatgpt-conversation-exporter",
    "// @version      0.2.2",
    "// @author       Christoph O'Bermair",
    "// @description  Export the current ChatGPT conversation as JSON.",
    "// @match        https://chatgpt.com/*",
    "// @run-at       document-idle",
    "// @grant        GM_registerMenuCommand",
    "// @grant        GM.registerMenuCommand",
    "// @grant        GM_getValue",
    "// @grant        GM_setValue",
    "// @grant        GM.getValue",
    "// @grant        GM.setValue",
    "// ==/UserScript=="
].join("\n");

const output = [
    metadata,
    "(function () {",
    core,
    profiling,
    compression,
    entry,
    "})();"
].join("\n\n") + "\n";

if (process.argv.includes("--check")) {
    if (!fs.existsSync(target) || fs.readFileSync(target, "utf8") !== output) {
        console.error("Userscript stimmt nicht mit dem Build-Quelltext überein.");
        process.exitCode = 1;
    } else {
        console.log("Userscript ist aktuell.");
    }
} else {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, output);
    console.log("Erstellt:", path.relative(root, target));
}
