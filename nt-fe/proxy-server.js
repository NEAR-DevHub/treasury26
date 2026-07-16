#!/usr/bin/env node

/**
 * Simple CORS proxy server for local development
 * Proxies requests from localhost:8080 to the production backend (api.trezu.app)
 * This avoids CORS issues when developing locally
 *
 * Usage: bun proxy-server.js
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PROXY_PORT = process.env.PROXY_PORT || 8888;
const TARGET_HOST = process.env.BACKEND_PROXY_TARGET || "https://api.trezu.app";

const server = http.createServer((req, res) => {
    // Get the origin from the request
    const origin = req.headers.origin || "http://localhost:3000";

    // Handle CORS preflight
    if (req.method === "OPTIONS") {
        res.writeHead(200, {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods":
                "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            "Access-Control-Allow-Headers":
                "Content-Type, Authorization, Cookie",
            "Access-Control-Allow-Credentials": "true",
        });
        res.end();
        return;
    }

    // Build target URL
    const targetUrl = new URL(req.url, TARGET_HOST);

    console.log(`[${req.method}] ${req.url} → ${targetUrl.href}`);

    // Prepare proxy request options
    const options = {
        hostname: targetUrl.hostname,
        port: targetUrl.port || (targetUrl.protocol === "https:" ? 443 : 80),
        path: targetUrl.pathname + targetUrl.search,
        method: req.method,
        headers: {
            ...req.headers,
            host: targetUrl.hostname,
        },
    };

    // Remove origin header to avoid CORS issues
    delete options.headers.origin;

    // Create proxy request
    const proxy = (targetUrl.protocol === "https:" ? https : http).request(
        options,
        (proxyRes) => {
            // Set CORS headers with specific origin (required for credentials mode)
            const headers = {
                ...proxyRes.headers,
                "access-control-allow-origin": origin,
                "access-control-allow-credentials": "true",
            };

            res.writeHead(proxyRes.statusCode, headers);
            proxyRes.pipe(res);
        },
    );

    proxy.on("error", (err) => {
        console.error("Proxy error:", err.message);
        res.writeHead(502, {
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
        });
        res.end(JSON.stringify({ error: "Proxy error", message: err.message }));
    });

    // Forward request body
    req.pipe(proxy);
});

server.listen(PROXY_PORT, () => {
    console.log("\n🔄 CORS Proxy Server");
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
    console.log(`📡 Listening on:  http://localhost:${PROXY_PORT}`);
    console.log(`🎯 Proxying to:   ${TARGET_HOST}`);
    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
    console.log(
        `Set NEXT_PUBLIC_BACKEND_API_BASE=http://localhost:${PROXY_PORT} in your frontend\n`,
    );
});

// Graceful shutdown
process.on("SIGTERM", () => {
    console.log("\n👋 Shutting down proxy server...");
    server.close();
    process.exit(0);
});
