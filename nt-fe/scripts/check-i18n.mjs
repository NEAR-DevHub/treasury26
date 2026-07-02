#!/usr/bin/env node
// Verifies translation files:
// 1. Every non-en locale has the same key set as en.
// 2. Every flat key in en.json is referenced in source (no dead keys).
//    Namespaces that use template-literal interpolation (`t(`${x}.title`)`)
//    are skipped for dead-key detection because keys can't be resolved
//    statically.
//
// Run: node scripts/check-i18n.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const messagesDir = join(root, "messages");

// ---------- helpers ----------

function flatten(obj, prefix = "") {
    const out = new Set();
    for (const [k, v] of Object.entries(obj)) {
        const key = prefix ? `${prefix}.${k}` : k;
        if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const x of flatten(v, key)) out.add(x);
        } else {
            out.add(key);
        }
    }
    return out;
}

function* walk(dir, ignore) {
    for (const entry of readdirSync(dir)) {
        if (ignore.has(entry)) continue;
        const p = join(dir, entry);
        const s = statSync(p);
        if (s.isDirectory()) yield* walk(p, ignore);
        else if (
            p.endsWith(".ts") ||
            p.endsWith(".tsx") ||
            p.endsWith(".mjs") ||
            p.endsWith(".js")
        )
            yield p;
    }
}

// ---------- 1. parity check ----------

const localeFiles = readdirSync(messagesDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(".json", ""));

if (!localeFiles.includes("en")) {
    console.error("missing messages/en.json");
    process.exit(1);
}

const flatByLocale = new Map();
for (const loc of localeFiles) {
    const data = JSON.parse(
        readFileSync(join(messagesDir, `${loc}.json`), "utf8"),
    );
    flatByLocale.set(loc, flatten(data));
}

const enKeys = flatByLocale.get("en");
const parityErrors = [];

for (const [loc, keys] of flatByLocale) {
    if (loc === "en") continue;
    const missing = [...enKeys].filter((k) => !keys.has(k));
    const extra = [...keys].filter((k) => !enKeys.has(k));
    if (missing.length || extra.length) {
        parityErrors.push({ loc, missing, extra });
    }
}

// ---------- 2. dead-key detection ----------

const ignoreDirs = new Set([
    "node_modules",
    ".next",
    "messages",
    "dist",
    ".git",
    "near-connect",
    "scripts",
    "playwright-report",
    "test-results",
    "e2e",
]);

// Map source file -> set of namespaces where dead-key detection must skip
// (because the file builds keys with template literals like
// `t(`${role.id}.title`)`).
const dynamicNamespaces = new Set();
const usedKeys = new Set();

const declRe =
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\s*\(\s*["']([^"']+)["']\s*\)/g;
// Static `t("key")` or `t.rich("key", { ... })`.
const callLiteralRe = (varName) =>
    new RegExp(`\\b${varName}(?:\\.rich)?\\s*\\(\\s*["']([^"'\\\\]+)["']`, "g");
// Template literal containing a `${...}` placeholder.
const callTemplateRe = (varName) =>
    new RegExp(`\\b${varName}\\s*\\(\\s*\`([^\`]*\\$\\{[^}]+\\}[^\`]*)\``, "g");
// Any non-literal first arg, e.g. `t(errorCode)`, `t.has(nestedKey)`,
// `t(statusKey(status))`. We treat the bound namespace as dynamic.
const callIdentifierRe = (varName) =>
    new RegExp(`\\b${varName}(?:\\.has|\\.rich)?\\s*\\(\\s*[A-Za-z_$]`, "g");
// Translator var passed as an argument to *another* function, e.g.
// `translateNearValidationError(t, errorCode)` or `buildLabels(t)`. The
// callee may call any key under the namespace, so we treat the namespace
// as dynamic.
const passedAsArgRe = (varName) =>
    new RegExp(
        `\\b[A-Za-z_$][A-Za-z0-9_$]*\\s*\\([^)]*\\b${varName}\\b[^)]*\\)`,
        "g",
    );

for (const file of walk(root, ignoreDirs)) {
    const src = readFileSync(file, "utf8");
    const decls = [];
    let m;
    declRe.lastIndex = 0;
    while ((m = declRe.exec(src)) !== null) {
        decls.push({ var: m[1], ns: m[2] });
    }
    if (decls.length === 0) continue;

    for (const { var: v, ns } of decls) {
        // Static `t("key")` calls
        const litRe = callLiteralRe(v);
        let c;
        while ((c = litRe.exec(src)) !== null) {
            usedKeys.add(`${ns}.${c[1]}`);
        }
        // Template-literal `t(`${x}.title`)` — mark namespace dynamic
        const tmplRe = callTemplateRe(v);
        while ((c = tmplRe.exec(src)) !== null) {
            dynamicNamespaces.add(ns);
        }
        // Bare-identifier `t(errorCode)` / `t.has(nestedKey)` — also dynamic
        const idRe = callIdentifierRe(v);
        while ((c = idRe.exec(src)) !== null) {
            dynamicNamespaces.add(ns);
        }
        // Translator passed as arg to another function — dynamic
        const argRe = passedAsArgRe(v);
        while ((c = argRe.exec(src)) !== null) {
            // Skip the declaration line itself (matched by useTranslations call)
            if (
                c[0].includes("useTranslations") ||
                c[0].includes("getTranslations")
            )
                continue;
            dynamicNamespaces.add(ns);
        }
    }
}

// A key is considered "used" if:
// - it appears literally in usedKeys, OR
// - any prefix of the key sits in dynamicNamespaces (so a dynamic `t(`${x}.foo`)`
//   inside `useTranslations("ns")` covers every `ns.*.foo` key).
function isUsed(key) {
    if (key.startsWith("warnings.situations.")) return true;
    if (usedKeys.has(key)) return true;
    const parts = key.split(".");
    for (let i = 1; i <= parts.length - 1; i++) {
        const prefix = parts.slice(0, i).join(".");
        if (dynamicNamespaces.has(prefix)) return true;
    }
    return false;
}

const deadKeys = [...enKeys].filter((k) => !isUsed(k)).sort();

// ---------- report ----------

let failed = false;

if (parityErrors.length === 0) {
    console.log(
        `✓ parity ok across ${flatByLocale.size} locales (${enKeys.size} keys each)`,
    );
} else {
    failed = true;
    console.error("✗ key parity broken:");
    for (const { loc, missing, extra } of parityErrors) {
        console.error(`  ${loc}.json:`);
        if (missing.length)
            console.error(
                `    missing ${missing.length}:\n      ${missing.slice(0, 20).join("\n      ")}${missing.length > 20 ? `\n      …(+${missing.length - 20})` : ""}`,
            );
        if (extra.length)
            console.error(
                `    extra ${extra.length}:\n      ${extra.slice(0, 20).join("\n      ")}${extra.length > 20 ? `\n      …(+${extra.length - 20})` : ""}`,
            );
    }
}

if (deadKeys.length === 0) {
    console.log(
        `✓ no dead translation keys (${usedKeys.size} unique static refs)`,
    );
} else {
    failed = true;
    console.error(
        `✗ ${deadKeys.length} dead translation keys (no source ref):`,
    );
    for (const k of deadKeys.slice(0, 50)) console.error(`  ${k}`);
    if (deadKeys.length > 50)
        console.error(`  … (+${deadKeys.length - 50} more)`);
}

if (dynamicNamespaces.size > 0) {
    console.log(
        `ℹ skipped dead-key check for ${dynamicNamespaces.size} dynamic namespace${dynamicNamespaces.size === 1 ? "" : "s"}: ${[...dynamicNamespaces].slice(0, 10).join(", ")}${dynamicNamespaces.size > 10 ? ", …" : ""}`,
    );
}

process.exit(failed ? 1 : 0);
