/**
 * Integration tests for the Trezu Wallet end-to-end flow.
 *
 * These tests simulate a real external dApp (e2e/test-dapp.html) that
 * communicates with the Trezu Wallet popup using the same postMessage protocol
 * that the near-connect trezu-wallet.js plugin uses.
 *
 * The full flow being tested:
 *   1. dApp opens /wallet?action=sign_in  → user selects treasury  → dApp gets accountId
 *   2. dApp opens /wallet?action=sign_transactions → user reviews proposal → cancels or...
 *   3. After DAO approval, dApp opens waiting-approval popup → clicks Proceed → gets tx hash
 *
 * The confirm-transactions step requires the user's personal NEAR wallet to sign
 * add_proposal on chain. Rather than bootstrapping a full NEAR signing stack, we
 * test that step at the UI level (correct preview, cancel works) and test the
 * post-creation flow (waiting-approval → approved → tx hash) separately.
 */

import { test, expect, BrowserContext, Page, Route } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";
import {
    registerMockWalletRoutes,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

const TEST_DAPP_HTML = fs.readFileSync(
    path.join(__dirname, "test-dapp.html"),
    "utf-8",
);

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const DAO_ID = "webassemblymusic-treasury.sputnik-dao.near";
const SIGNED_IN_ACCOUNT = "alice.near";

const PROPOSAL_ID = 42;
const TX_HASH = "7HBqrPAEtBVR5dRHKqtpFBgJqwWnmjXDDvQ3NEAR1abc";
const DUMMY_DAPP_URL = "/test-dapp.html";

/** submission_time in nanoseconds (2025-02-18T00:00:00Z). */
const SUBMISSION_TIME_NS = "1739836800000000000";

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

const TREASURY_RESPONSE = [
    {
        daoId: DAO_ID,
        config: { name: "WebAssembly Music", purpose: "", metadata: {} },
        isMember: true,
    },
];

/**
 * Mock backend API routes + NearConnect manifest/executor on the context
 * (applies to all pages including popups).
 */
async function mockBackendRoutes(context: BrowserContext) {
    // Serve mock NearConnect manifest so the wallet popup auto-connects
    await registerMockWalletRoutes(context);

    // Serve the dummy dApp from e2e/ (not public/) so it's never shipped to prod.
    await context.route("**/test-dapp.html", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "text/html",
            body: TEST_DAPP_HTML,
        });
    });

    await context.route("**/api/user/treasuries*", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(TREASURY_RESPONSE),
        });
    });

    await context.route("**/api/treasury/policy*", async (route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                proposal_bond: "100000000000000000000000",
                proposal_period: "604800000000000",
            }),
        });
    });

    await context.route(
        `**/api/proposal/${DAO_ID}/${PROPOSAL_ID}/tx*`,
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ transaction_hash: TX_HASH }),
            });
        },
    );

    await context.route(
        `**/api/proposal/${DAO_ID}/${PROPOSAL_ID}`,
        async (route) => {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    id: PROPOSAL_ID,
                    status: "Approved",
                    submission_time: SUBMISSION_TIME_NS,
                    description: "Proposal from external dApp",
                    kind: { Transfer: {} },
                    proposer: SIGNED_IN_ACCOUNT,
                    vote_counts: {},
                    votes: {},
                    last_actions_log: null,
                }),
            });
        },
    );
}

/**
 * Seed the NearConnector wallet account in localStorage.
 * Same-origin popups share localStorage, so this pre-connects the mock wallet
 * for any popup opened after this call.
 */
async function seedWalletAccount(page: Page, accountId: string) {
    await seedMockWalletAccount(page, accountId, "evaluate");
}

/**
 * Simulate the dApp already being in the "connected" state (sign_in done).
 * Sets connectedAs on the page and enables the transaction buttons.
 */
async function simulateConnected(page: Page, daoId: string) {
    await page.evaluate((dao) => {
        (window as any).connectedAs = dao;
        const btns = ["transfer-btn", "ftcall-btn"];
        for (const id of btns) {
            const el = document.getElementById(id) as HTMLButtonElement | null;
            if (el) el.disabled = false;
        }
        const status = document.getElementById("status");
        if (status) status.textContent = "Status: Connected as " + dao;
    }, daoId);
}

/* ------------------------------------------------------------------ */
/* Test 1: sign_in roundtrip                                            */
/* ------------------------------------------------------------------ */

test.describe("sign_in: connect via Trezu Wallet popup", () => {
    test("user selects treasury → dApp receives DAO account as signed-in accountId", async ({
        page,
        context,
    }) => {
        test.setTimeout(60_000);

        await mockBackendRoutes(context);
        await page.goto(DUMMY_DAPP_URL);

        // Seed mock wallet account — localStorage is shared across same-origin pages,
        // so the wallet popup will also see this and skip the "Connect Wallet" step.
        await seedWalletAccount(page, SIGNED_IN_ACCOUNT);

        const popupPromise = context.waitForEvent("page");
        await page.click("#connect-btn");
        const popup = await popupPromise;

        // Wallet popup should reach the select-treasury step
        await popup.waitForSelector("text=Select a treasury", {
            timeout: 15_000,
        });

        // Click the treasury
        await popup.click(`button:has-text("${DAO_ID}")`);

        // Popup shows done confirmation
        await popup.waitForSelector("text=Signed in successfully", {
            timeout: 8_000,
        });

        // dApp received trezu:result with the DAO account
        const msg = await page
            .waitForFunction(() => (window as any).__lastMessage, {
                timeout: 5_000,
            })
            .then((h) => h.jsonValue());
        expect(msg).toMatchObject({
            type: "trezu:result",
            status: "success",
            accountId: DAO_ID,
        });

        await expect(page.locator("#status")).toContainText(
            `Connected as ${DAO_ID}`,
        );
    });
});

/* ------------------------------------------------------------------ */
/* Test 2: sign_transactions — proposal preview UI (Transfer)          */
/* ------------------------------------------------------------------ */

test.describe("sign_transactions: Transfer NEAR proposal preview", () => {
    test("wallet popup shows Transfer proposal; cancelling returns failure to dApp", async ({
        page,
        context,
    }) => {
        test.setTimeout(60_000);

        await mockBackendRoutes(context);
        await page.goto(DUMMY_DAPP_URL);

        await seedWalletAccount(page, SIGNED_IN_ACCOUNT);
        await simulateConnected(page, DAO_ID);

        // Click "Transfer 1 NEAR to alice.near"
        const popupPromise = context.waitForEvent("page");
        await page.click("#transfer-btn");
        const popup = await popupPromise;

        // The wallet popup auto-selects the DAO (signerId matches) and
        // shows the confirm-transactions step.
        await popup.waitForSelector("text=Create Proposal", {
            timeout: 15_000,
        });

        // Verify the proposal preview shows the correct recipient
        await expect(popup.locator("text=alice.near").first()).toBeVisible();

        // Acting-as block shows the selected DAO
        await expect(popup.locator(`text=${DAO_ID}`).first()).toBeVisible();

        // Cancel → popup closes and dApp receives failure
        await popup.click("button:has-text('Cancel')");

        const msg = await page
            .waitForFunction(() => (window as any).__lastMessage, {
                timeout: 5_000,
            })
            .then((h) => h.jsonValue());
        expect(msg).toMatchObject({
            type: "trezu:result",
            status: "failure",
            errorMessage: "User cancelled",
        });
    });
});

/* ------------------------------------------------------------------ */
/* Test 3: sign_transactions — FunctionCall proposal preview           */
/* ------------------------------------------------------------------ */

test.describe("sign_transactions: FunctionCall (ft_transfer) proposal preview", () => {
    test("wallet popup shows ft_transfer method and usdt.tether-token.near contract; cancel returns failure", async ({
        page,
        context,
    }) => {
        test.setTimeout(60_000);

        await mockBackendRoutes(context);
        await page.goto(DUMMY_DAPP_URL);

        await seedWalletAccount(page, SIGNED_IN_ACCOUNT);
        await simulateConnected(page, DAO_ID);

        const popupPromise = context.waitForEvent("page");
        await page.click("#ftcall-btn");
        const popup = await popupPromise;

        await popup.waitForSelector("text=Create Proposal", {
            timeout: 15_000,
        });

        // The wallet renders the recipient from ft_transfer args (receiver_id),
        // not from the raw function name.
        await expect(popup.locator("text=alice.near").first()).toBeVisible();

        // Amount is shown in token units for the FT contract used in this call.
        await expect(popup.getByText("Amount1.00 USDT")).toBeVisible();

        await popup.click("button:has-text('Cancel')");

        const msg = await page
            .waitForFunction(() => (window as any).__lastMessage, {
                timeout: 5_000,
            })
            .then((h) => h.jsonValue());
        expect(msg).toMatchObject({
            type: "trezu:result",
            status: "failure",
            errorMessage: "User cancelled",
        });
    });
});

/* ------------------------------------------------------------------ */
/* Test 4: waiting-approval → approved → dApp receives tx hash         */
/* ------------------------------------------------------------------ */

test.describe("waiting-approval: after DAO votes Approve, dApp receives tx hash", () => {
    /**
     * This test simulates the second phase of the sign_transactions flow:
     * the proposal was already submitted (proposalId=42), treasury members voted,
     * and now the user clicks "Proceed" in the wallet popup to retrieve the tx hash.
     *
     * The popup is opened by the dApp via window.open() so window.opener is set,
     * and the URL includes daoId+proposalIds to jump straight to waiting-approval.
     */
    test("Proceed after approval sends transactionHashes to dApp opener", async ({
        page,
        context,
    }) => {
        test.setTimeout(60_000);

        await mockBackendRoutes(context);
        await page.goto(DUMMY_DAPP_URL);

        // Open the wallet popup from the dApp page so window.opener is set.
        // Use waiting-approval URL params to skip the signing step.
        const popupPromise = context.waitForEvent("page");
        await page.evaluate(
            ({ daoId, proposalId }) => {
                const url = new URL("/wallet", window.location.origin);
                url.searchParams.set("action", "sign_transactions");
                url.searchParams.set("network", "mainnet");
                url.searchParams.set("daoId", daoId);
                url.searchParams.set("proposalIds", String(proposalId));
                window.open(
                    url.toString(),
                    "TrezuWallet",
                    "width=520,height=700",
                );
            },
            { daoId: DAO_ID, proposalId: PROPOSAL_ID },
        );
        const popup = await popupPromise;

        // Should be at the waiting-approval step immediately
        await popup.waitForSelector("text=Proposal Submitted", {
            timeout: 10_000,
        });

        // Shows the proposal link
        await expect(
            popup.locator(`text=${DAO_ID} — Proposal #${PROPOSAL_ID}`),
        ).toBeVisible();

        // Click "Proceed" — proposal API is mocked as Approved
        await popup.click(
            "button:has-text('The Proposal is Approved. Proceed')",
        );

        // Popup shows "done" step
        await popup.waitForSelector("text=Proposal created successfully", {
            timeout: 10_000,
        });

        // dApp received the trezu:result with the transaction hash
        const msg = await page
            .waitForFunction(() => (window as any).__lastMessage, {
                timeout: 5_000,
            })
            .then((h) => h.jsonValue());
        expect(msg).toMatchObject({
            type: "trezu:result",
            status: "success",
            transactionHashes: TX_HASH,
        });
    });

    test("InProgress status shows 'still pending' error without closing popup", async ({
        page,
        context,
    }) => {
        test.setTimeout(60_000);

        // Set up all base mocks first, then override the proposal route to return InProgress
        await mockBackendRoutes(context);
        await context.route(
            `**/api/proposal/${DAO_ID}/${PROPOSAL_ID}`,
            async (route) => {
                await route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        id: PROPOSAL_ID,
                        status: "InProgress",
                        submission_time: SUBMISSION_TIME_NS,
                        description: "Pending",
                        kind: { Transfer: {} },
                        proposer: SIGNED_IN_ACCOUNT,
                        vote_counts: {},
                        votes: {},
                        last_actions_log: null,
                    }),
                });
            },
        );

        await page.goto(DUMMY_DAPP_URL);

        const popupPromise = context.waitForEvent("page");
        await page.evaluate(
            ({ daoId, proposalId }) => {
                const url = new URL("/wallet", window.location.origin);
                url.searchParams.set("action", "sign_transactions");
                url.searchParams.set("network", "mainnet");
                url.searchParams.set("daoId", daoId);
                url.searchParams.set("proposalIds", String(proposalId));
                window.open(
                    url.toString(),
                    "TrezuWallet",
                    "width=520,height=700",
                );
            },
            { daoId: DAO_ID, proposalId: PROPOSAL_ID },
        );
        const popup = await popupPromise;

        await popup.waitForSelector("text=Proposal Submitted", {
            timeout: 10_000,
        });

        await popup.click(
            "button:has-text('The Proposal is Approved. Proceed')",
        );

        // Shows pending message instead of closing
        await popup.waitForSelector("text=Proposal is still pending approval", {
            timeout: 8_000,
        });

        // Popup stays open; dApp has not received any message
        // (use evaluate, not waitForFunction — we assert the value is absent)
        const msg = await page.evaluate(() => (window as any).__lastMessage);
        expect(msg).toBeUndefined();
    });
});
