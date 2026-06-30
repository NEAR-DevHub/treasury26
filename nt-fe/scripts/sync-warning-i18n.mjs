#!/usr/bin/env node
/**
 * Extracts translatable templates from shared/status-situations.json
 * and injects them into each locale's messages file under warnings.situations.
 *
 * Run: node scripts/sync-warning-i18n.mjs
 *
 * For non-English locales, only ADDS missing keys (preserves existing translations).
 * For English, always overwrites from source of truth.
 */
import { readFileSync, writeFileSync, readdirSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(__dirname, "../../shared/status-situations.json");
const messagesDir = resolve(__dirname, "../messages");

const catalog = JSON.parse(readFileSync(catalogPath, "utf-8"));

function buildSituationsBlock() {
    const block = {};

    for (const sit of catalog.situations) {
        const entry = {};

        if (sit.message) {
            entry.default = sit.message;
        }

        if (sit.byPlacement) {
            const I18N_KEY_MAP = { "login.wallet.*": "loginWallet" };
            for (const [key, val] of Object.entries(sit.byPlacement)) {
                entry[I18N_KEY_MAP[key] ?? key] = val;
            }
        }

        if (sit.messagesByScope) {
            for (const [key, val] of Object.entries(sit.messagesByScope)) {
                entry[key] = val;
            }
        }

        if (Object.keys(entry).length > 0) {
            block[sit.id] = entry;
        }
    }

    return block;
}

const situationsBlock = buildSituationsBlock();

const localeFiles = readdirSync(messagesDir).filter((f) => f.endsWith(".json"));

for (const file of localeFiles) {
    const filePath = resolve(messagesDir, file);
    const messages = JSON.parse(readFileSync(filePath, "utf-8"));
    const isEnglish = file === "en.json";

    if (!messages.warnings) {
        messages.warnings = {};
    }

    if (isEnglish) {
        messages.warnings.situations = situationsBlock;
    } else {
        if (!messages.warnings.situations) {
            messages.warnings.situations = {};
        }
        for (const [sitId, templates] of Object.entries(situationsBlock)) {
            if (!messages.warnings.situations[sitId]) {
                messages.warnings.situations[sitId] = { ...templates };
            } else {
                for (const [key, val] of Object.entries(templates)) {
                    if (!messages.warnings.situations[sitId][key]) {
                        messages.warnings.situations[sitId][key] = val;
                    }
                }
            }
        }
    }

    writeFileSync(filePath, JSON.stringify(messages, null, 4) + "\n");
}

console.log(
    `✓ synced warning situation templates to ${localeFiles.length} locale files`,
);
