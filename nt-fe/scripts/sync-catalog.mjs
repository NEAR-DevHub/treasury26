#!/usr/bin/env node
/**
 * Copies shared/status-situations.json into lib/generated/.
 * Run automatically via `predev` and `prebuild` hooks.
 */
import { readFileSync, mkdirSync, writeFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const src = resolve(__dirname, "../../shared/status-situations.json");
const dest = resolve(__dirname, "../lib/generated/status-situations.json");

mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest, readFileSync(src));
console.log("✓ synced shared/status-situations.json → lib/generated/");
