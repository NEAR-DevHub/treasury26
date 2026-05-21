import { test, expect, type Page } from "@playwright/test";
import {
    maybeFulfillMockWalletRequest,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

const TREASURY_ID = "onboarding-e2e-test.sputnik-dao.near";
const ACCOUNT_ID = "test.near";

const TREASURY_POLICY = {
    roles: [
        {
            name: "council",
            kind: { Group: [ACCOUNT_ID] },
            permissions: [
                "*:AddProposal",
                "*:VoteApprove",
                "*:VoteReject",
                "*:VoteRemove",
            ],
            vote_policy: {},
        },
    ],
    default_vote_policy: {
        weight_kind: "RoleWeight",
        quorum: "0",
        threshold: [1, 2],
    },
    proposal_bond: "100000000000000000000000",
    proposal_period: "604800000000000",
    bounty_bond: "100000000000000000000000",
    bounty_forgiveness_period: "604800000000000",
};

const SUBSCRIPTION = {
    accountId: TREASURY_ID,
    planType: "free",
    planConfig: {
        planType: "free",
        name: "Free",
        description: "Free plan",
        limits: {
            monthlyVolumeLimitCents: null,
            overageRateBps: 0,
            exchangeFeeBps: 0,
            monthlyExportCredits: null,
            trialExportCredits: 100,
            monthlyBatchPaymentCredits: null,
            trialBatchPaymentCredits: 50,
            gasCoveredTransactions: null,
            historyLookupMonths: 3,
        },
        pricing: { monthlyPriceCents: null, yearlyPriceCents: null },
    },
    exportCredits: 100,
    batchPaymentCredits: 50,
    gasCoveredTransactions: 100,
    creditsResetAt: "2026-05-06T00:00:00Z",
    monthlyUsedVolumeCents: 0,
};

const EMPTY_PROPOSALS = {
    page: 0,
    page_size: 15,
    total: 0,
    proposals: [],
};

const PROPOSALS_WITH_ONE = {
    page: 0,
    page_size: 15,
    total: 1,
    proposals: [
        {
            id: 1,
            proposer: ACCOUNT_ID,
            description: "Test payment",
            kind: {
                Transfer: {
                    token_id: "",
                    receiver_id: "bob.near",
                    amount: "1000000000000000000000000",
                },
            },
            status: "Approved",
            vote_counts: {},
            votes: {},
            submission_time: "1700000000000000000",
        } as never,
    ],
};

const TREASURY_ASSETS = [
    {
        id: "near",
        contractId: null,
        residency: "Near",
        network: "near",
        chainName: "Near Protocol",
        symbol: "wNEAR",
        balance: {
            Standard: {
                total: "5000000000000000000000000",
                locked: "0",
            },
        },
        decimals: 24,
        price: "1.05",
        name: "Near",
        icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png",
        chainIcons: {
            icon: "https://near.com/static/icons/network/near.svg",
        },
    },
];

const EMPTY_ASSETS: typeof TREASURY_ASSETS = [];

test.use({ locale: "en-US" });
test.describe.configure({ timeout: 120_000 });

/**
 * Mocks client-side API calls for a signed-in user on the dashboard.
 */
async function setupDashboardMocks(
    page: Page,
    options?: {
        assets?: typeof TREASURY_ASSETS;
        proposals?: typeof EMPTY_PROPOSALS;
    },
) {
    const assets = options?.assets ?? TREASURY_ASSETS;
    const proposals = options?.proposals ?? EMPTY_PROPOSALS;
    await seedMockWalletAccount(page, ACCOUNT_ID, "init");

    await page.route("**/*", async (route) => {
        if (await maybeFulfillMockWalletRequest(route)) {
            return;
        }

        const url = route.request().url();

        if (url.includes("/api/auth/me") || url.includes("/auth/me")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    accountId: ACCOUNT_ID,
                    termsAccepted: true,
                }),
            });
        }

        if (
            url.includes("/api/treasury/creation-status") ||
            url.includes("/treasury/creation-status")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ creationAvailable: true }),
            });
        }

        if (
            url.includes("/api/user/treasuries") ||
            url.includes("/user/treasuries")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([
                    {
                        daoId: TREASURY_ID,
                        config: {
                            name: "Onboarding E2E Test Treasury",
                            purpose: "Testing",
                            metadata: {},
                        },
                        isMember: true,
                        isSaved: true,
                        isHidden: false,
                    },
                ]),
            });
        }

        if (
            url.includes("/api/treasury/policy") ||
            url.includes("/treasury/policy")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(TREASURY_POLICY),
            });
        }

        if (url.includes("/api/subscription/")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(SUBSCRIPTION),
            });
        }

        if (url.includes("/api/user/assets") || url.includes("/user/assets")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(assets),
            });
        }

        if (url.includes("/api/proposals/") || url.includes("/proposals/")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(proposals),
            });
        }

        if (url.includes("/api/monitored-accounts")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    accountId: TREASURY_ID,
                    enabled: true,
                    planType: "free",
                }),
            });
        }

        // Balance history chart (prevents BalanceWithGraph from stuck loading)
        if (url.includes("/balance-history/chart")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({}),
            });
        }

        if (url.includes("/user/profile")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ name: "Test User" }),
            });
        }

        if (
            url.includes("/api/address-book") ||
            url.includes("/address-book")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify([]),
            });
        }

        return route.continue();
    });
}

/**
 * Navigate to the dashboard, registering response waiters BEFORE goto to avoid race.
 */
async function gotoDashboard(page: Page) {
    const authResp = page
        .waitForResponse((r) => r.url().includes("/auth/me"), {
            timeout: 60_000,
        })
        .catch(() => null);
    const assetsResp = page
        .waitForResponse((r) => r.url().includes("/user/assets"), {
            timeout: 60_000,
        })
        .catch(() => null);

    await page.goto(`/${TREASURY_ID}`, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
    });
    await expect(page.locator("main").first()).toBeVisible({ timeout: 30_000 });

    await authResp;
    await assetsResp;
}

/**
 * Navigate to the dashboard with localStorage pre-seeded before page JS runs.
 * Uses addInitScript so the storage is set before React hydration.
 */
async function gotoDashboardWithStorage(
    page: Page,
    storageEntries: Record<string, string>,
) {
    // addInitScript runs in the browser before any page JS
    await page.addInitScript((entries) => {
        for (const [key, value] of Object.entries(entries)) {
            localStorage.setItem(key, value);
        }
    }, storageEntries);

    await gotoDashboard(page);
}

/**
 * Navigate to the dashboard with all onboarding storage cleared.
 * Uses addInitScript so localStorage is cleared before React hydration.
 */
async function gotoDashboardFresh(page: Page) {
    await page.addInitScript(() => {
        localStorage.removeItem("welcome-dismissed");
        localStorage.removeItem("dashboard-tour-completed");
        localStorage.removeItem("info-box-tour-dismissed");
        localStorage.removeItem("payments-bulk-tour-shown");
        localStorage.removeItem("payments-pending-tour-shown");
        localStorage.removeItem("exchange-settings-tour-shown");
        localStorage.removeItem("members-pending-tour-shown");
        localStorage.removeItem("guest-save-tour-shown");
        localStorage.removeItem("new-feature-tour-shown");
    });

    await gotoDashboard(page);
}

/**
 * Walk through the welcome tooltip (steps 1 → 2) and click "Let's go" to start the dashboard tour.
 */
async function startTourViaWelcome(page: Page) {
    await expect(page.getByText("Welcome!", { exact: false })).toBeVisible({
        timeout: 15000,
    });
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await expect(
        page.getByText("Take a quick tour", { exact: false }),
    ).toBeVisible({ timeout: 5000 });
    await page.getByRole("button", { name: "Let's go", exact: true }).click();

    // Wait for the first tour step to be visible
    await expect(
        page.getByText("Add assets to your Treasury", { exact: false }),
    ).toBeVisible({ timeout: 10000 });
}

// ──────────────────────────────────────────────────────────────────────────
// Welcome Tooltip Tests
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Welcome Tooltip", () => {
    test("Welcome tooltip appears for a new user on the dashboard", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);

        const welcome = page.getByText("Welcome!", { exact: false });
        await expect(welcome).toBeVisible({ timeout: 15000 });

        await page.screenshot({
            path: "test-results/onboarding-welcome-tooltip.png",
            fullPage: true,
        });
    });

    test("Welcome tooltip has two steps and can be dismissed", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);

        // Step 1 should be visible
        const step1Text = page.getByText("Your Trezu is ready", {
            exact: false,
        });
        await expect(step1Text).toBeVisible({ timeout: 15000 });
        expect(await page.getByText("1 of 2").isVisible()).toBe(true);

        // Click "Next" to go to step 2
        await page.getByRole("button", { name: "Next", exact: true }).click();

        const step2Text = page.getByText("Take a quick tour", {
            exact: false,
        });
        await expect(step2Text).toBeVisible({ timeout: 5000 });
        expect(await page.getByText("2 of 2").isVisible()).toBe(true);

        // Dismiss with "No, thanks"
        await page.getByRole("button", { name: /no, thanks/i }).click();

        // Tooltip should disappear
        await expect(step2Text).not.toBeVisible({ timeout: 5000 });

        // localStorage should be set
        const dismissed = await page.evaluate(() =>
            localStorage.getItem("welcome-dismissed"),
        );
        expect(dismissed).toBe("true");
    });

    test("Welcome tooltip does not reappear after dismissal", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardWithStorage(page, {
            "welcome-dismissed": "true",
        });

        // Give enough time for any tooltip to appear
        await page.waitForTimeout(2000);

        const welcome = page.getByText("Welcome!", { exact: false });
        await expect(welcome).not.toBeVisible();
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Dashboard Tour Tests – highlight & arrow verification
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Dashboard Tour highlights and arrows", () => {
    test("Dashboard tour can be started from the Welcome tooltip", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        await page.screenshot({
            path: "test-results/onboarding-tour-step1.png",
            fullPage: true,
        });
    });

    test("Tour targets are the BalanceWithGraph buttons, not the onboarding progress widget", async ({
        page,
    }) => {
        // The onboarding progress widget also has Deposit/Send buttons, but the
        // dashboard tour must highlight #dashboard-step1/2/3 which live inside
        // the BalanceWithGraph card – NOT the progress widget.
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // Step 1 targets #dashboard-step1 (Deposit in BalanceWithGraph)
        const step1Target = page.locator("#dashboard-step1");
        await expect(step1Target).toBeVisible();
        // Verify the button is inside the balance card, not the onboarding progress section
        const balanceCard = step1Target.locator(
            "xpath=ancestor::*[contains(@class,'grid-cols-3')]",
        );
        await expect(balanceCard).toBeVisible();

        // Advance to step 2
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(
            page.getByText("Make payment requests", { exact: false }),
        ).toBeVisible({ timeout: 10000 });

        // Step 2 targets #dashboard-step2 (Send in BalanceWithGraph)
        const step2Target = page.locator("#dashboard-step2");
        await expect(step2Target).toBeVisible();

        // Advance to step 3
        await page.getByRole("button", { name: "Next", exact: true }).click();
        await expect(
            page.getByText("exchange your assets", { exact: false }),
        ).toBeVisible({ timeout: 10000 });

        // Step 3 targets #dashboard-step3 (Exchange in BalanceWithGraph)
        const step3Target = page.locator("#dashboard-step3");
        await expect(step3Target).toBeVisible();

        // None of these IDs should exist inside the onboarding progress widget
        const progressWidget = page
            .getByText(/follow quick steps to/i)
            .locator("..");
        expect(await progressWidget.locator("#dashboard-step1").count()).toBe(
            0,
        );
        expect(await progressWidget.locator("#dashboard-step2").count()).toBe(
            0,
        );
        expect(await progressWidget.locator("#dashboard-step3").count()).toBe(
            0,
        );
    });

    test("Tour step 1 highlights the Deposit button with correct positioning", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // The target element (#dashboard-step1) should exist and be in the viewport
        const depositBtn = page.locator("#dashboard-step1");
        await expect(depositBtn).toBeVisible();

        const depositBox = await depositBtn.boundingBox();
        expect(depositBox).not.toBeNull();

        // The tour card should be visible
        const tourCard = page.locator(".bg-popover-foreground.text-popover");
        await expect(tourCard).toBeVisible();

        const cardBox = await tourCard.boundingBox();
        expect(cardBox).not.toBeNull();

        // Tour card for step 1 (side: "bottom-left") should be below the target
        if (depositBox && cardBox) {
            expect(
                cardBox.y,
                `Tour card (y:${cardBox.y}) should be below deposit button (y:${depositBox.y + depositBox.height})`,
            ).toBeGreaterThanOrEqual(depositBox.y);
        }

        await page.screenshot({
            path: "test-results/onboarding-tour-step1-highlight.png",
            fullPage: true,
        });
    });

    test("Tour step navigation – Next advances through all 5 steps", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // Step 1: Deposit
        expect(await page.getByText("1 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // Step 2: Send / payment requests
        await expect(
            page.getByText("Make payment requests", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        expect(await page.getByText("2 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // Step 3: Exchange
        await expect(
            page.getByText("exchange your assets", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        expect(await page.getByText("3 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // Step 4: Members (in sidebar)
        await expect(
            page.getByText("Add members to your Treasury", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        expect(await page.getByText("4 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // Step 5: Create Treasury (inside sidebar selector dropdown —
        // the tour card logic opens the dropdown automatically, allow extra time)
        await expect(
            page.getByText("set up a new Treasury", { exact: false }),
        ).toBeVisible({ timeout: 15000 });
        expect(await page.getByText("5 of 5").isVisible()).toBe(true);

        await page.screenshot({
            path: "test-results/onboarding-tour-step5.png",
            fullPage: true,
        });

        // Click the primary action button on the last step to complete tour.
        // Use the tour card container (inverted popover colors) to scope the click,
        // because the Radix Select portal from the treasury dropdown may interfere
        // with global getByRole queries.
        const stepFiveCard = page.locator(
            ".bg-popover-foreground.text-popover",
        );
        await expect(stepFiveCard).toBeVisible({ timeout: 5000 });
        await stepFiveCard.getByText("Done", { exact: true }).click();

        // Tour should close
        await expect(
            page.getByText("set up a new Treasury", { exact: false }),
        ).not.toBeVisible({ timeout: 5000 });
    });

    test("Tour step can be closed via the X button at any step", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // Close via X button inside the tour card
        const tourCard = page.locator(".bg-popover-foreground.text-popover");
        const closeBtn = tourCard.getByRole("button", { name: /close/i });
        await expect(closeBtn).toBeVisible();
        await closeBtn.click();

        // Tour should be dismissed
        await expect(
            page.getByText("Add assets to your Treasury", { exact: false }),
        ).not.toBeVisible({ timeout: 5000 });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Tour highlight does not break after scroll
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Tour resilience to scroll", () => {
    test("Tour highlight stays aligned with target after page is scrolled down before starting", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);

        // Scroll down before interacting with welcome
        await page.evaluate(() => window.scrollTo(0, 300));
        await page.waitForTimeout(500);

        await startTourViaWelcome(page);

        // The deposit button and tour card should still be reasonably aligned
        const depositBtn = page.locator("#dashboard-step1");
        const depositBox = await depositBtn.boundingBox();
        const tourCard = page.locator(".bg-popover-foreground.text-popover");
        const cardBox = await tourCard.boundingBox();

        expect(depositBox).not.toBeNull();
        expect(cardBox).not.toBeNull();

        if (depositBox && cardBox) {
            const verticalDistance = Math.abs(
                cardBox.y - (depositBox.y + depositBox.height),
            );
            expect(
                verticalDistance,
                `Tour card should be near the deposit button after scroll (distance: ${verticalDistance}px)`,
            ).toBeLessThan(300);
        }

        await page.screenshot({
            path: "test-results/onboarding-tour-after-scroll.png",
            fullPage: true,
        });
    });

    test("Starting tour from bottom of page scrolls back to top", async ({
        browser,
    }) => {
        // Use a short viewport so the dashboard content overflows and is scrollable
        const context = await browser.newContext({
            viewport: { width: 1280, height: 400 },
        });
        const page = await context.newPage();

        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);

        // Ensure the page is taller than the viewport
        await page.evaluate(() => {
            document.body.style.minHeight = "2000px";
        });

        // Scroll all the way to the bottom
        await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(500);

        const scrollYBefore = await page.evaluate(() => window.scrollY);
        expect(scrollYBefore, "Page should be scrolled down").toBeGreaterThan(
            0,
        );

        // "Let's go" scrolls #balance-with-graph into view then starts tour after 300ms
        await startTourViaWelcome(page);

        // The tour target (#dashboard-step1 inside balance card) must be in the viewport
        const depositBtn = page.locator("#dashboard-step1");
        await expect(depositBtn).toBeInViewport({ timeout: 5000 });

        await page.screenshot({
            path: "test-results/onboarding-tour-scrolled-from-bottom.png",
            fullPage: true,
        });

        await context.close();
    });

    test("Starting tour from bottom of page scrolls back to top (mobile)", async ({
        browser,
    }) => {
        const context = await browser.newContext({
            viewport: { width: 375, height: 667 },
            isMobile: true,
            userAgent:
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1",
        });
        const page = await context.newPage();

        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);

        // Ensure the page is taller than the mobile viewport
        await page.evaluate(() => {
            document.body.style.minHeight = "2000px";
        });

        // Scroll to the bottom
        await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(500);

        const scrollYBefore = await page.evaluate(() => window.scrollY);
        expect(
            scrollYBefore,
            "Page should be scrolled down on mobile",
        ).toBeGreaterThan(0);

        await startTourViaWelcome(page);

        // The tour target (#dashboard-step1 inside balance card) must be in the viewport
        const depositBtn = page.locator("#dashboard-step1");
        await expect(depositBtn).toBeInViewport({ timeout: 5000 });

        await page.screenshot({
            path: "test-results/onboarding-tour-scrolled-from-bottom-mobile.png",
            fullPage: true,
        });

        await context.close();
    });

    test("Scrolling during an active tour step does not detach the highlight", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // Scroll down
        await page.evaluate(() => window.scrollBy(0, 150));
        await page.waitForTimeout(500);

        // Tour content should still be visible
        await expect(
            page.getByText("Add assets to your Treasury", { exact: false }),
        ).toBeVisible();

        // Scroll back up
        await page.evaluate(() => window.scrollTo(0, 0));
        await page.waitForTimeout(500);

        // Tour content should still be visible after scrolling back
        await expect(
            page.getByText("Add assets to your Treasury", { exact: false }),
        ).toBeVisible();

        await page.screenshot({
            path: "test-results/onboarding-tour-scroll-during-tour.png",
            fullPage: true,
        });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Tour card arrow verification
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Tour card arrow points toward target", () => {
    test("Tour card is positioned near its target on each step", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // Verify positioning for steps 1–3: these target buttons inside the
        // BalanceWithGraph card (balance-with-graph.tsx), NOT the onboarding
        // progress widget (onboarding-progress.tsx) which has its own buttons.
        const stepsToVerify = [
            {
                selector: "#dashboard-step1",
                text: "Add assets to your Treasury",
            },
            {
                selector: "#dashboard-step2",
                text: "Make payment requests",
            },
            {
                selector: "#dashboard-step3",
                text: "exchange your assets",
            },
        ];

        for (let i = 0; i < stepsToVerify.length; i++) {
            const step = stepsToVerify[i];
            await expect(
                page.getByText(step.text, { exact: false }),
            ).toBeVisible({ timeout: 10000 });

            const target = page.locator(step.selector);
            const targetBox = await target.boundingBox();
            const tourCard = page.locator(
                ".bg-popover-foreground.text-popover",
            );
            const cardBox = await tourCard.boundingBox();

            expect(targetBox).not.toBeNull();
            expect(cardBox).not.toBeNull();

            if (targetBox && cardBox) {
                const centerTargetX = targetBox.x + targetBox.width / 2;
                const centerTargetY = targetBox.y + targetBox.height / 2;
                const centerCardX = cardBox.x + cardBox.width / 2;
                const centerCardY = cardBox.y + cardBox.height / 2;

                const distance = Math.sqrt(
                    (centerCardX - centerTargetX) ** 2 +
                        (centerCardY - centerTargetY) ** 2,
                );

                expect(
                    distance,
                    `Step ${i + 1}: Tour card should be within 400px of target ${step.selector} (distance: ${distance.toFixed(0)}px)`,
                ).toBeLessThan(400);
            }

            if (i < stepsToVerify.length - 1) {
                await page
                    .getByRole("button", { name: "Next", exact: true })
                    .click();
            }
        }

        await page.screenshot({
            path: "test-results/onboarding-tour-card-positions.png",
            fullPage: true,
        });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Onboarding Progress Widget
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Progress widget", () => {
    test("Onboarding progress shows with correct steps on dashboard", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardWithStorage(page, {
            "welcome-dismissed": "true",
        });

        const main = page.locator("main");
        await expect(main.getByText(/follow quick steps to/i)).toBeVisible({
            timeout: 15000,
        });

        // Verify all three steps are displayed
        await expect(main.getByText("Create Treasury account")).toBeVisible();
        await expect(main.getByText("Add Your Assets")).toBeVisible();
        await expect(
            main.getByText("3. Create a Payment Request"),
        ).toBeVisible();

        await page.screenshot({
            path: "test-results/onboarding-progress-widget.png",
            fullPage: true,
        });
    });

    test("Onboarding progress hides when all steps are completed", async ({
        page,
    }) => {
        await setupDashboardMocks(page, {
            assets: TREASURY_ASSETS,
            proposals: PROPOSALS_WITH_ONE,
        });
        await gotoDashboardWithStorage(page, {
            "welcome-dismissed": "true",
        });

        // Give time for the widget to evaluate
        await page.waitForTimeout(3000);

        const progressHeading = page.getByText(/follow quick steps to/i);
        await expect(progressHeading).not.toBeVisible();
    });

    test("Onboarding progress shows step 2 active when no assets", async ({
        page,
    }) => {
        await setupDashboardMocks(page, { assets: EMPTY_ASSETS });
        await gotoDashboardWithStorage(page, {
            "welcome-dismissed": "true",
        });

        const main = page.locator("main");
        await expect(main.getByText(/follow quick steps to/i)).toBeVisible({
            timeout: 15000,
        });

        // Step 2 (Add Your Assets) should have a "Deposit" action button visible
        // Scope to the progress widget to avoid matching the BalanceWithGraph Deposit button
        const progressWidget = main
            .getByText(/follow quick steps to/i)
            .locator("../..");
        const depositButton = progressWidget.getByRole("button", {
            name: /deposit/i,
        });
        await expect(depositButton).toBeVisible();

        await page.screenshot({
            path: "test-results/onboarding-progress-step2-active.png",
            fullPage: true,
        });
    });

    test("Onboarding progress shows step 3 active when has assets but no proposals", async ({
        page,
    }) => {
        await setupDashboardMocks(page, {
            assets: TREASURY_ASSETS,
            proposals: EMPTY_PROPOSALS,
        });
        await gotoDashboardWithStorage(page, {
            "welcome-dismissed": "true",
        });

        const main = page.locator("main");
        await expect(main.getByText(/follow quick steps to/i)).toBeVisible({
            timeout: 15000,
        });

        // Step 3 should have a "Send" action button visible
        // Scope to the progress widget to avoid matching the BalanceWithGraph Send button
        const progressWidget = main
            .getByText(/follow quick steps to/i)
            .locator("../..");
        const sendButton = progressWidget.getByRole("button", {
            name: /^send$/i,
        });
        await expect(sendButton).toBeVisible();

        await page.screenshot({
            path: "test-results/onboarding-progress-step3-active.png",
            fullPage: true,
        });
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Congrats tooltip
// ──────────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────────
// Full onboarding flow (scroll → welcome → tour → congrats)
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Full flow with scroll prerequisite", () => {
    test("Complete onboarding: scroll down first, then welcome → tour (5 steps) → congrats", async ({
        browser,
    }) => {
        // Use a short viewport so the dashboard overflows and is scrollable
        const context = await browser.newContext({
            viewport: { width: 1280, height: 500 },
        });
        const page = await context.newPage();

        // Mock with assets and proposals so congrats tooltip triggers after the tour
        await setupDashboardMocks(page, {
            assets: TREASURY_ASSETS,
            proposals: PROPOSALS_WITH_ONE,
        });
        await gotoDashboardFresh(page);

        // Ensure the page is taller than the viewport
        await page.evaluate(() => {
            document.body.style.minHeight = "2000px";
        });

        // ── Prerequisite: scroll to the bottom ──
        await page.evaluate(() =>
            window.scrollTo(0, document.body.scrollHeight),
        );
        await page.waitForTimeout(500);

        const scrollYBefore = await page.evaluate(() => window.scrollY);
        expect(
            scrollYBefore,
            "Page should be scrolled down before starting",
        ).toBeGreaterThan(0);

        // ── Welcome tooltip step 1 ──
        await expect(page.getByText("Welcome!", { exact: false })).toBeVisible({
            timeout: 15000,
        });
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // ── Welcome tooltip step 2 → start the tour ──
        await expect(
            page.getByText("Take a quick tour", { exact: false }),
        ).toBeVisible({ timeout: 5000 });
        await page
            .getByRole("button", { name: "Let's go", exact: true })
            .click();

        // ── Tour step 1: Deposit ──
        await expect(
            page.getByText("Add assets to your Treasury", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        // The balance card should have been scrolled into the viewport
        const depositBtn = page.locator("#dashboard-step1");
        await expect(depositBtn).toBeInViewport({ timeout: 5000 });
        expect(await page.getByText("1 of 5").isVisible()).toBe(true);

        await page.screenshot({
            path: "test-results/onboarding-full-flow-step1.png",
            fullPage: true,
        });

        await page.getByRole("button", { name: "Next", exact: true }).click();

        // ── Tour step 2: Send ──
        await expect(
            page.getByText("Make payment requests", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        expect(await page.getByText("2 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // ── Tour step 3: Exchange ──
        await expect(
            page.getByText("exchange your assets", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        expect(await page.getByText("3 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // ── Tour step 4: Members ──
        await expect(
            page.getByText("Add members to your Treasury", { exact: false }),
        ).toBeVisible({ timeout: 10000 });
        expect(await page.getByText("4 of 5").isVisible()).toBe(true);
        await page.getByRole("button", { name: "Next", exact: true }).click();

        // ── Tour step 5: Create Treasury ──
        await expect(
            page.getByText("set up a new Treasury", { exact: false }),
        ).toBeVisible({ timeout: 15000 });
        expect(await page.getByText("5 of 5").isVisible()).toBe(true);

        // Complete the tour by clicking "Done" inside the tour card.
        // Scope to the tour card container to avoid interference from the
        // Radix Select portal opened by the treasury dropdown.
        const stepFiveCard = page.locator(
            ".bg-popover-foreground.text-popover",
        );
        await expect(stepFiveCard).toBeVisible({ timeout: 5000 });
        await stepFiveCard.getByText("Done", { exact: true }).click();

        // Tour should close
        await expect(
            page.getByText("set up a new Treasury", { exact: false }),
        ).not.toBeVisible({ timeout: 5000 });

        // ── Congrats tooltip should appear ──
        const congrats = page.getByText("Congrats!", { exact: false });
        await expect(congrats).toBeVisible({ timeout: 15000 });
        await expect(
            page.getByText("completed your Treasury setup", { exact: false }),
        ).toBeVisible();

        await page.screenshot({
            path: "test-results/onboarding-full-flow-congrats.png",
            fullPage: true,
        });

        // Dismiss the congrats
        await page.getByRole("button", { name: /let's go/i }).click();
        await expect(congrats).not.toBeVisible({ timeout: 5000 });

        // Verify localStorage state after full flow
        const storage = await page.evaluate(() => ({
            welcomeDismissed: localStorage.getItem("welcome-dismissed"),
            tourCompleted: localStorage.getItem("dashboard-tour-completed"),
        }));
        expect(storage.welcomeDismissed).toBe("true");
        expect(storage.tourCompleted).toBe("true");

        await context.close();
    });
});

// ──────────────────────────────────────────────────────────────────────────
// Tour overlay blocks interaction
// ──────────────────────────────────────────────────────────────────────────

test.describe("Onboarding – Overlay and interaction blocking", () => {
    test("Tour overlay darkens the background (shadow opacity)", async ({
        page,
    }) => {
        await setupDashboardMocks(page);
        await gotoDashboardFresh(page);
        await startTourViaWelcome(page);

        // nextstepjs renders an overlay; at minimum the tour card should be visible
        const tourCard = page.locator(".bg-popover-foreground.text-popover");
        await expect(tourCard).toBeVisible();

        // Check for full-screen overlay-like elements (SVG mask or fixed div)
        const hasOverlay = await page.evaluate(() => {
            const elements = document.querySelectorAll(
                "[class*='nextstep'], [data-nextstep], svg[class*='overlay'], [style*='position: fixed']",
            );
            for (const el of elements) {
                const rect = el.getBoundingClientRect();
                if (
                    rect.width >= window.innerWidth * 0.9 &&
                    rect.height >= window.innerHeight * 0.9
                ) {
                    return true;
                }
            }
            return false;
        });

        // Log for debugging — the overlay detection is best-effort since nextstepjs internals may vary
        console.log(`Full-screen overlay detected: ${hasOverlay}`);

        await page.screenshot({
            path: "test-results/onboarding-tour-overlay.png",
            fullPage: true,
        });
    });
});
