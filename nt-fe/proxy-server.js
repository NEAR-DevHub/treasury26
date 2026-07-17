#!/usr/bin/env node

/**
 * Same-origin auth proxy for local development.
 *
 * Runs the backend on the SAME site as the frontend (both `localhost`) so
 * the session cookie — set `Secure; SameSite=Strict` by the backend — is
 * actually sent on authenticated calls. Pointing the frontend directly at
 * `https://api.*.trezu.app` makes those calls cross-site, so the browser
 * stores the login cookie but never attaches it (accept-terms / me fail
 * with "Missing authentication token").
 *
 * Usage:
 *   bun proxy:staging            # proxy → staging backend
 *   bun proxy:prod               # proxy → production backend
 *   BACKEND_PROXY_TARGET=<url> node proxy-server.js
 * then run the frontend with NEXT_PUBLIC_BACKEND_API_BASE=http://localhost:8888
 * (see the `dev:proxied` script).
 */

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PROXY_PORT = process.env.PROXY_PORT || 8888;
const TARGET_HOST =
    process.env.BACKEND_PROXY_TARGET || "https://api.testenv.trezu.app";

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

            // Rewrite Set-Cookie so the backend's session cookie is stored
            // for this http://localhost:<port> origin: drop `Secure` (we are
            // on http) and any `Domain=…trezu.app` (host-only for localhost).
            // `SameSite` is left as-is — localhost:3000 → localhost:<port> is
            // same-site, so even `Strict` cookies are sent.
            const setCookie = proxyRes.headers["set-cookie"];
            if (setCookie) {
                headers["set-cookie"] = (
                    Array.isArray(setCookie) ? setCookie : [setCookie]
                ).map((c) =>
                    c
                        .replace(/;\s*Secure/gi, "")
                        .replace(/;\s*Domain=[^;]*/gi, ""),
                );
            }

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
