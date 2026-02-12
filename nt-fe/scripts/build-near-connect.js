const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const projectRoot = process.cwd();
const nearConnectDir = path.join(
    projectRoot,
    "node_modules",
    "@hot-labs",
    "near-connect",
);
const nearConnectBuildEntry = path.join(nearConnectDir, "build", "index.js");
const tscCli = path.join(
    projectRoot,
    "node_modules",
    "typescript",
    "bin",
    "tsc",
);
const nearConnectTsconfig = path.join(nearConnectDir, "tsconfig.json");

if (!fs.existsSync(nearConnectDir)) {
    process.exit(0);
}

if (fs.existsSync(nearConnectBuildEntry)) {
    process.exit(0);
}

if (!fs.existsSync(tscCli)) {
    console.error(
        "[postinstall] TypeScript compiler not found; cannot build @hot-labs/near-connect.",
    );
    process.exit(1);
}

if (!fs.existsSync(nearConnectTsconfig)) {
    console.error(
        "[postinstall] Missing tsconfig in @hot-labs/near-connect; cannot build package.",
    );
    process.exit(1);
}

console.log("[postinstall] Building @hot-labs/near-connect from source...");
const result = spawnSync(
    process.execPath,
    [tscCli, "-p", nearConnectTsconfig],
    {
        stdio: "inherit",
    },
);

if (result.status !== 0) {
    console.error("[postinstall] Failed to build @hot-labs/near-connect.");
    process.exit(result.status || 1);
}

console.log("[postinstall] Built @hot-labs/near-connect successfully.");
