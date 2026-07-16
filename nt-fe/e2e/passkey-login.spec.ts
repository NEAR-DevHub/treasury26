import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The Passkey executor artifact is vendored (near-connect/vendor) and copied
// to .next/static/near-connect/passkey-executor.js at build time. The spec is
// skipped until the artifact ships (Passkey stays behind the warnings kill
// switch until then).
const EXECUTOR_ARTIFACT = path.join(
    __dirname,
    "..",
    "near-connect",
    "vendor",
    "passkey-executor.js",
);

// Helper: JSON-RPC call_function result body (bytes of JSON)
function callFunctionResult(id: unknown, value: unknown) {
    return {
        jsonrpc: "2.0",
        id,
        result: {
            block_hash: "A".repeat(44),
            block_height: 100000000,
            logs: [],
            result: Array.from(new TextEncoder().encode(JSON.stringify(value))),
        },
    };
}

test("Passkey login flow (create + NEP-641 resolveAuth)", async ({
    page,
    context,
}) => {
    test.skip(
        !fs.existsSync(EXECUTOR_ARTIFACT),
        "passkey-executor.js artifact not vendored yet",
    );
    test.setTimeout(120000);

    const logs: string[] = [];
    page.on("console", (msg) => {
        logs.push(msg.text());
        if (msg.type() === "error") {
            console.log("CONSOLE ERROR:", msg.text());
        }
    });
    page.on("pageerror", (error) => {
        console.log("PAGE ERROR:", error.message);
    });

    // WebAuthn ceremonies run in the TOP window (near-connect proxies
    // navigator.credentials from the sandboxed iframe), so a page-level CDP
    // virtual authenticator covers the whole flow.
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: {
            protocol: "ctap2",
            transport: "internal",
            hasResidentKey: true,
            hasUserVerification: true,
            isUserVerified: true,
            automaticPresenceSimulation: true,
        },
    });

    // Serve the executor from the vendored artifact so the test doesn't
    // depend on the postbuild copy step having run.
    await context.route("**/near-connect/passkey-executor.js", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/javascript",
            body: fs.readFileSync(EXECUTOR_ARTIFACT, "utf8"),
        }),
    );

    // NEAR RPC mocks: registry lookups, wallet-contract config views,
    // account state and transaction submission.
    await context.route(
        /rpc\.(mainnet|testnet)?\.?(fastnear\.com|near\.org)/,
        async (route) => {
            const body = JSON.parse(route.request().postData() ?? "{}");
            let result: unknown;

            if (body.method === "query") {
                const p = body.params ?? {};
                if (p.request_type === "call_function") {
                    switch (p.method_name) {
                        case "get": // passkeys-registry.near
                            result = callFunctionResult(body.id, []);
                            break;
                        case "w_is_signature_allowed":
                            result = callFunctionResult(body.id, true);
                            break;
                        case "w_subwallet_id":
                            result = callFunctionResult(body.id, 0);
                            break;
                        case "w_timeout_secs":
                            result = callFunctionResult(body.id, 3600);
                            break;
                        case "w_extensions":
                            result = callFunctionResult(body.id, []);
                            break;
                        default:
                            result = callFunctionResult(body.id, null);
                    }
                } else if (p.request_type === "view_account") {
                    // Wallet account exists — the executor skips StateInit
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            amount: "0",
                            locked: "0",
                            code_hash: "11111111111111111111111111111111",
                            storage_usage: 500,
                            storage_paid_at: 0,
                            block_height: 100000000,
                            block_hash: "A".repeat(44),
                        },
                    };
                } else if (p.request_type === "view_access_key") {
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            block_hash: "A".repeat(44),
                            block_height: 100000000,
                            nonce: 1,
                            permission: {
                                FunctionCall: {
                                    allowance: null,
                                    receiver_id: "passkeys-registry.near",
                                    method_names: ["register"],
                                },
                            },
                        },
                    };
                } else {
                    result = { jsonrpc: "2.0", id: body.id, result: {} };
                }
            } else if (body.method === "block") {
                result = {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        header: {
                            hash: "A".repeat(44),
                            height: 100000000,
                            timestamp: Date.now() * 1e6,
                        },
                    },
                };
            } else if (
                body.method === "send_tx" ||
                body.method === "broadcast_tx_commit"
            ) {
                // Registry `register` / relayed transactions succeed
                result = {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        final_execution_status: "FINAL",
                        status: { SuccessValue: "" },
                        transaction: {},
                        transaction_outcome: {
                            outcome: { status: { SuccessValue: "" } },
                        },
                        receipts_outcome: [],
                    },
                };
            } else {
                result = { jsonrpc: "2.0", id: body.id, result: {} };
            }

            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(result),
            });
        },
    );

    // Backend auth mocks (same pattern as the Ledger spec)
    let isLoggedIn = false;
    let resolvedAccountId: string | null = null;

    await context.route("**/api/auth/challenge", (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ payload: "Login to Trezu — test payload" }),
        }),
    );

    await context.route("**/api/auth/login", async (route) => {
        const body = JSON.parse(route.request().postData() ?? "{}");
        // The executor must produce a NEP-641 authorization blob for a
        // deterministic 0s… wallet account.
        expect(body.accountId).toMatch(/^0s[0-9a-f]{40}$/);
        const authorization = JSON.parse(body.authorization);
        expect(authorization.message.purpose).toBe("PROVE_OWNERSHIP");
        expect(authorization.message.recipient).toBe("Trezu App");
        expect(authorization.message.payload).toBe(
            "Login to Trezu — test payload",
        );
        expect(authorization.proof).toBeTruthy();

        resolvedAccountId = body.accountId;
        isLoggedIn = true;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                accountId: body.accountId,
                termsAccepted: true,
            }),
        });
    });

    await context.route("**/api/auth/me", (route) =>
        isLoggedIn
            ? route.fulfill({
                  status: 200,
                  contentType: "application/json",
                  body: JSON.stringify({
                      accountId: resolvedAccountId,
                      termsAccepted: true,
                  }),
              })
            : route.fulfill({
                  status: 401,
                  contentType: "application/json",
                  body: JSON.stringify({ error: "Not authenticated" }),
              }),
    );

    // Navigate and open the sign-in screen
    await page.goto("/create");
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page.getByText("Choose how to sign in")).toBeVisible();

    // Passkey card must be present without the "Coming soon" gate
    const passkeyOption = page.getByRole("button", { name: "Passkey" });
    await expect(passkeyOption).toBeVisible();
    await passkeyOption.click();

    // The executor UI renders inside the sandboxed iframe
    const iframe = page
        .frameLocator('iframe[sandbox*="allow-scripts"]')
        .first();

    // Fresh browser: choose to create a new passkey; the CDP virtual
    // authenticator answers both the create() and the resolveAuth get()
    // ceremonies automatically.
    const createBtn = iframe.getByRole("button", {
        name: /create new passkey/i,
    });
    await expect(createBtn).toBeVisible({ timeout: 15000 });
    await createBtn.click();

    // Login completes: the sign-in screen goes away
    await expect(page.getByText("Choose how to sign in")).not.toBeVisible({
        timeout: 30000,
    });
    expect(resolvedAccountId).toMatch(/^0s[0-9a-f]{40}$/);
});
