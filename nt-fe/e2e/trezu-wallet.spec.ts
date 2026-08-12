import { test, expect, Page, Route } from "@playwright/test";
import {
    registerMockWalletRoutes,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

/**
 * E2E tests for the Trezu Wallet page (/wallet).
 *
 * The /wallet page is a standalone popup that external dApps open to:
 *   1. sign_in  — let the user pick a treasury to sign in as
 *   2. sign_transactions — convert dApp transactions into DAO proposals
 *
 * The page communicates results back to the opener via postMessage:
 *   { type: "trezu:result", status: "success"|"failure", ... }
 *
 * Testing strategy
 * ----------------
 * Most states can be reached directly via URL params without a real NEAR
 * wallet connection:
 *
 *  • connect step       — default when no daoId/proposalIds in URL
 *  • error step         — triggered by malformed `transactions` base64
 *  • waiting-approval   — restored from ?daoId=…&proposalIds=…
 *
 * The waiting-approval step has no manual "Proceed" button: it polls the
 * backend (immediately on entry, then every 10s) and auto-advances to the
 * done step once every proposal is Approved and its execution tx is indexed.
 *
 * The authenticated flow (sign_in → treasury list → done) requires a full
 * session: a backend session cookie (mocked via /api/auth/me) AND a connected
 * near-connect wallet. We simulate the wallet by intercepting the NearConnect
 * manifest (served from GitHub/jsDelivr CDN) to return a custom mock wallet
 * and seeding localStorage["selected-wallet"] = "mock-wallet" plus
 * localStorage["mock-wallet:signedAccountId"] = accountId before page load.
 *
 * postMessage assertions use page.addInitScript to mock window.opener before
 * the page boots.
 */

/** Encode a value as the UTF-8-safe base64 format used by jsonToBase64() */
function jsonToBase64(value: unknown): string {
    const uint8Array = new TextEncoder().encode(JSON.stringify(value));
    let binary = "";
    for (let i = 0; i < uint8Array.length; i++) {
        binary += String.fromCharCode(uint8Array[i]);
    }
    return btoa(binary);
}

const DAO_ID = "treasury.sputnik-dao.near";

/** Mock the backend session endpoint. Pass null for a logged-out session. */
async function mockAuthMe(page: Page, accountId: string | null) {
    await page.route("**/api/auth/me", async (route: Route) => {
        if (accountId) {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ accountId, termsAccepted: true }),
            });
        } else {
            await route.fulfill({
                status: 401,
                contentType: "application/json",
                body: JSON.stringify({ error: "unauthorized" }),
            });
        }
    });
}

/**
 * Simulate a fully authenticated user: backend session (auth/me) + connected
 * mock wallet (NearConnect manifest interception + seeded localStorage).
 */
async function setupAuthenticatedUser(page: Page, accountId: string) {
    await registerMockWalletRoutes(page);
    await seedMockWalletAccount(page, accountId, "init");
    await mockAuthMe(page, accountId);
}

/** Capture opener postMessages into window.__walletMessages before page boot */
async function captureOpenerMessages(page: Page) {
    await page.addInitScript(() => {
        (window as any).__walletMessages = [];
        Object.defineProperty(window, "opener", {
            configurable: true,
            get: () => ({
                postMessage: (data: unknown) => {
                    (window as any).__walletMessages.push(data);
                },
            }),
        });
        window.close = () => {};
    });
}

async function mockPolicy(page: Page) {
    await page.route("**/api/treasury/policy*", async (route: Route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                proposal_period: "604800000000000",
                proposal_bond: "0",
            }),
        });
    });
}

async function mockProposalStatus(
    page: Page,
    proposalId: number,
    status: string,
) {
    await page.route(
        `**/api/proposal/${DAO_ID}/${proposalId}`,
        async (route: Route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: proposalId,
                    status,
                    submission_time: String(Date.now() * 1_000_000),
                    description: "Test proposal",
                    kind: {},
                    proposer: "alice.near",
                    vote_counts: {},
                    votes: {},
                    last_actions_log: null,
                }),
            });
        },
    );
}

// ---------- connect step ----------

test.describe("connect step (sign_in)", () => {
    test("shows Connect Wallet button when not signed in", async ({ page }) => {
        await mockAuthMe(page, null);
        await page.goto("/wallet?action=sign_in&network=mainnet");

        await expect(
            page.getByRole("button", { name: "Connect Wallet" }),
        ).toBeVisible({ timeout: 10_000 });
    });

    test("shows Connect Wallet button for sign_transactions before wallet connects", async ({
        page,
    }) => {
        await mockAuthMe(page, null);
        const transactions = [
            {
                receiverId: "some.near",
                actions: [
                    {
                        type: "FunctionCall",
                        params: {
                            methodName: "transfer",
                            args: { receiver_id: "alice.near", amount: "1" },
                            gas: "100000000000000",
                            deposit: "0",
                        },
                    },
                ],
            },
        ];

        const url = `/wallet?action=sign_transactions&network=mainnet&transactions=${jsonToBase64(transactions)}`;
        await page.goto(url);

        await expect(
            page.getByRole("button", { name: "Connect Wallet" }),
        ).toBeVisible({ timeout: 10_000 });
    });
});

// ---------- error step ----------

test.describe("error step", () => {
    test("shows error for malformed transactions base64", async ({ page }) => {
        await mockAuthMe(page, null);
        await page.goto(
            "/wallet?action=sign_transactions&network=mainnet&transactions=!!!not-valid-base64!!!",
        );

        await expect(
            page.getByText("Failed to parse the transaction request"),
        ).toBeVisible({ timeout: 10_000 });
        // "Try again" button resets to connect step
        await expect(
            page.getByRole("button", { name: "Try again" }),
        ).toBeVisible();
    });

    test("Try again resets to connect step", async ({ page }) => {
        await mockAuthMe(page, null);
        await page.goto(
            "/wallet?action=sign_transactions&network=mainnet&transactions=!!!bad!!!",
        );
        await expect(
            page.getByText("Failed to parse the transaction request"),
        ).toBeVisible({ timeout: 10_000 });

        await page.getByRole("button", { name: "Try again" }).click();

        await expect(
            page.getByRole("button", { name: "Connect Wallet" }),
        ).toBeVisible({ timeout: 5_000 });
    });
});

// ---------- waiting-approval step (URL restoration) ----------

test.describe("waiting-approval step", () => {
    test("restores state from URL params with a single proposal", async ({
        page,
    }) => {
        const proposalId = 42;

        await mockAuthMe(page, null);
        await mockPolicy(page);
        await mockProposalStatus(page, proposalId, "InProgress");

        await page.goto(
            `/wallet?action=sign_transactions&network=mainnet&daoId=${DAO_ID}&proposalIds=${proposalId}`,
        );

        await expect(page.getByText("What To Do Next")).toBeVisible({
            timeout: 10_000,
        });
        // Link to the proposal should be visible
        await expect(
            page.getByText(`${DAO_ID} — Proposal #${proposalId}`),
        ).toBeVisible();
        await expect(
            page.getByRole("button", { name: "Open Trezu to Approve" }),
        ).toBeVisible();
    });

    test("restores state with multiple proposal IDs", async ({ page }) => {
        const proposalIds = [1, 2, 3];

        await mockAuthMe(page, null);
        await mockPolicy(page);
        for (const id of proposalIds) {
            await mockProposalStatus(page, id, "InProgress");
        }

        await page.goto(
            `/wallet?action=sign_transactions&network=mainnet&daoId=${DAO_ID}&proposalIds=${proposalIds.join(",")}`,
        );

        await expect(page.getByText("What To Do Next")).toBeVisible({
            timeout: 10_000,
        });
        for (const id of proposalIds) {
            await expect(
                page.getByText(`${DAO_ID} — Proposal #${id}`),
            ).toBeVisible();
        }
    });

    test("stays on the checklist while the proposal is InProgress", async ({
        page,
    }) => {
        const proposalId = 42;

        await captureOpenerMessages(page);
        await mockAuthMe(page, null);
        await mockPolicy(page);
        await mockProposalStatus(page, proposalId, "InProgress");

        await page.goto(
            `/wallet?action=sign_transactions&network=mainnet&daoId=${DAO_ID}&proposalIds=${proposalId}`,
        );
        await expect(page.getByText("What To Do Next")).toBeVisible({
            timeout: 10_000,
        });

        // The immediate status check ran and found InProgress — the page must
        // stay on the checklist and send nothing to the opener.
        await page.waitForTimeout(1_000);
        await expect(page.getByText("What To Do Next")).toBeVisible();
        const messages = await page.evaluate(
            () => (window as any).__walletMessages,
        );
        expect(messages).toHaveLength(0);
    });

    test("auto-advances and sends success postMessage when proposal is Approved and tx hash found", async ({
        page,
    }) => {
        const proposalId = 42;
        const txHash = "abc123txhash456";

        await captureOpenerMessages(page);
        await mockAuthMe(page, null);
        await mockPolicy(page);
        await mockProposalStatus(page, proposalId, "Approved");

        await page.route(
            `**/api/proposal/${DAO_ID}/${proposalId}/tx*`,
            async (route: Route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({ transaction_hash: txHash }),
                });
            },
        );

        await page.goto(
            `/wallet?action=sign_transactions&network=mainnet&daoId=${DAO_ID}&proposalIds=${proposalId}`,
        );

        // The status poll runs immediately on entry: the page should
        // transition to the done step without any clicking.
        await expect(page.getByText("You can close this window.")).toBeVisible({
            timeout: 10_000,
        });

        // Should have sent a success result to the opener
        const messages = await page.evaluate(
            () => (window as any).__walletMessages,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            type: "trezu:result",
            status: "success",
            transactionHashes: expect.stringContaining(txHash),
        });
    });

    test("shows note when tx endpoint fails (proposal not indexed yet)", async ({
        page,
    }) => {
        const proposalId = 99;

        await mockAuthMe(page, null);
        await mockPolicy(page);
        await mockProposalStatus(page, proposalId, "Approved");

        // Tx endpoint returns 404 (not indexed yet)
        await page.route(
            `**/api/proposal/${DAO_ID}/${proposalId}/tx*`,
            async (route: Route) => {
                await route.fulfill({ status: 404 });
            },
        );

        await page.goto(
            `/wallet?action=sign_transactions&network=mainnet&daoId=${DAO_ID}&proposalIds=${proposalId}`,
        );

        // Should show "not yet indexed" note while staying on the checklist
        await expect(page.getByText(/not yet indexed/)).toBeVisible({
            timeout: 10_000,
        });
        await expect(page.getByText("What To Do Next")).toBeVisible();
    });

    test("rejected proposal shows error step and sends failure postMessage", async ({
        page,
    }) => {
        const proposalId = 42;

        await captureOpenerMessages(page);
        await mockAuthMe(page, null);
        await mockPolicy(page);
        await mockProposalStatus(page, proposalId, "Rejected");

        await page.goto(
            `/wallet?action=sign_transactions&network=mainnet&daoId=${DAO_ID}&proposalIds=${proposalId}`,
        );

        await expect(
            page.getByText(`Proposal #${proposalId} was rejected`),
        ).toBeVisible({ timeout: 10_000 });

        const messages = await page.evaluate(
            () => (window as any).__walletMessages,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            type: "trezu:result",
            status: "failure",
            errorMessage: "Proposal was rejected",
        });
    });
});

// ---------- sign_in with an authenticated session ----------

test.describe("sign_in with authenticated session", () => {
    test("shows treasury selection when session is valid (select-treasury step)", async ({
        page,
    }) => {
        await setupAuthenticatedUser(page, "alice.near");

        await page.route("**/api/user/treasuries*", async (route: Route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    {
                        daoId: DAO_ID,
                        config: { name: "My Test Treasury" },
                        isMember: true,
                    },
                ]),
            });
        });

        await page.goto("/wallet?action=sign_in&network=mainnet");

        // Should skip connect step and go directly to treasury selection
        await expect(
            page.getByText("Choose which treasury you want to use"),
        ).toBeVisible({ timeout: 10_000 });
        await expect(page.getByText(DAO_ID)).toBeVisible();
        await expect(page.getByText("My Test Treasury")).toBeVisible();
    });

    test("clicking a treasury sends success postMessage (sign_in done step)", async ({
        page,
    }) => {
        await setupAuthenticatedUser(page, "alice.near");
        await captureOpenerMessages(page);

        await page.route("**/api/user/treasuries*", async (route: Route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    {
                        daoId: DAO_ID,
                        config: { name: "My Test Treasury" },
                        isMember: true,
                    },
                ]),
            });
        });

        await page.goto("/wallet?action=sign_in&network=mainnet");

        await expect(page.getByText(DAO_ID)).toBeVisible({ timeout: 10_000 });
        await page.getByText(DAO_ID).click();

        // Should show done step
        await expect(page.getByText("Treasury connected")).toBeVisible({
            timeout: 5_000,
        });

        // Should have sent the DAO account ID as the signed-in account
        const messages = await page.evaluate(
            () => (window as any).__walletMessages,
        );
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            type: "trezu:result",
            status: "success",
            accountId: DAO_ID,
        });
    });
});
