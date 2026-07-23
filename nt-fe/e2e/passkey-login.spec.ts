import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

// The Passkey executor ships from the NEAR-DevHub/near-connect-passkey main branch
// (served via raw.githubusercontent.com — see lib/passkey-wallet.ts). The spec
// route-mocks that URL with a locally-built artifact from a sibling checkout of
// the executor repo, and skips when it isn't present (e.g. CI without the
// sibling repo — Passkey stays behind the warnings kill switch until then).
const EXECUTOR_ARTIFACT = path.join(
    __dirname,
    "..",
    "..",
    "..",
    "near-connect-passkey",
    "passkey-executor.js",
);

// Public part of the executor's embedded function-call key for
// passkeys-registry.near (REGISTRY_FC_PRIVATE_KEY in the vendored
// constants). Used to satisfy the registration transaction's key lookup.
const FC_PUBLIC_KEY = "ed25519:4rPkq4P1KwD4kVuUETqL5wLUEH3hEHqwiuSEKVC3fUwT";

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

    // Serve the executor from the locally-built artifact instead of fetching
    // it from GitHub, so the test has no network dependency.
    // Match with an optional cache-busting query string: near-connect
    // fetches the executor as `…/passkey-executor.js?nonce=<per-session>`.
    await context.route("**/passkey-executor.js*", (route) =>
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
                } else if (p.request_type === "view_access_key_list") {
                    // near-api-ts's memory signer enumerates the account's
                    // keys to find the one it signs with — return the
                    // executor's embedded function-call key (public part).
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            block_hash: "A".repeat(44),
                            block_height: 100000000,
                            keys: [
                                {
                                    public_key: FC_PUBLIC_KEY,
                                    access_key: {
                                        nonce: 1,
                                        permission: {
                                            FunctionCall: {
                                                allowance: null,
                                                receiver_id:
                                                    "passkeys-registry.near",
                                                method_names: ["register"],
                                            },
                                        },
                                    },
                                },
                            ],
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
                // Registry `register` / relayed transactions succeed. Shape
                // must satisfy near-api-ts's FinalExecutionOutcomeView zod
                // schema (send_tx uses wait_until=EXECUTED_OPTIMISTIC).
                const hash = "A".repeat(44);
                const outcome = {
                    executor_id: "passkeys-registry.near",
                    gas_burnt: 0,
                    logs: [],
                    receipt_ids: [],
                    status: { SuccessValue: "" },
                    tokens_burnt: "0",
                };
                result = {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        final_execution_status: "EXECUTED_OPTIMISTIC",
                        status: { SuccessValue: "" },
                        transaction: {
                            actions: [],
                            hash,
                            nonce: 1,
                            public_key: FC_PUBLIC_KEY,
                            receiver_id: "passkeys-registry.near",
                            signature:
                                "ed25519:11111111111111111111111111111111",
                            signer_id: "passkeys-registry.near",
                        },
                        transaction_outcome: {
                            block_hash: hash,
                            id: hash,
                            outcome,
                            proof: [],
                        },
                        receipts_outcome: [],
                    },
                };
            } else if (body.method === "EXPERIMENTAL_protocol_config") {
                // near-api-ts's getAccountInfo needs the storage price.
                result = {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {
                        runtime_config: {
                            storage_amount_per_byte: "10000000000000000000",
                        },
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

    // Fresh browser: choose to create a new account. The CDP virtual
    // authenticator answers both the create() and the resolveAuth get()
    // ceremonies automatically.
    const createBtn = iframe.getByRole("button", {
        name: /create new account/i,
    });
    await expect(createBtn).toBeVisible({ timeout: 15000 });
    await createBtn.click();

    // Name-your-passkey step: accept the default name.
    const confirmCreateBtn = iframe.getByRole("button", {
        name: /create passkey/i,
    });
    await expect(confirmCreateBtn).toBeVisible({ timeout: 15000 });
    await confirmCreateBtn.click();

    // Login completes: the sign-in screen goes away
    await expect(page.getByText("Choose how to sign in")).not.toBeVisible({
        timeout: 30000,
    });
    expect(resolvedAccountId).toMatch(/^0s[0-9a-f]{40}$/);
});
