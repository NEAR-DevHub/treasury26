// Copies the vendored Passkey executor artifact next to trezu-wallet.js so it
// is served from our origin (https://trezu.app/_next/static/near-connect/
// passkey-executor.js — see lib/passkey-wallet.ts).
//
// The artifact is the committed build output of
// https://github.com/near/near-connect-passkey (single-file IIFE). Update it
// by copying a new build into vendor/ AND bumping PASSKEY_EXECUTOR_VERSION in
// lib/passkey-wallet.ts (near-connect caches executors by id:version).
const fs = require("node:fs");
const path = require("node:path");

const src = path.join(__dirname, "vendor", "passkey-executor.js");
const outDir = path.join(__dirname, "..", ".next", "static", "near-connect");
const dest = path.join(outDir, "passkey-executor.js");

if (!fs.existsSync(src)) {
    // Passkey stays behind the warnings kill switch until the artifact ships,
    // so a missing vendor file must not break the build.
    console.warn(
        "[near-connect] vendor/passkey-executor.js not found — Passkey wallet will not be available",
    );
    process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(src, dest);
console.log(
    `[near-connect] copied passkey-executor.js (${fs.statSync(dest).size} bytes)`,
);
