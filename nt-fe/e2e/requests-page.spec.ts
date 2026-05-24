import { test, expect, type Page } from "@playwright/test";
import {
    maybeFulfillMockWalletRequest,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

const TREASURY_ID = "requests-e2e-test.sputnik-dao.near";
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

test.use({ locale: "en-US" });

/**
 * Mocks client-side API calls for a signed-in user who owns a newly created treasury.
 * Server-side calls (getTreasuryConfig in layout.tsx) are handled by the real sandbox backend.
 */
async function setupRequestsPageMocks(page: Page) {
    await seedMockWalletAccount(page, ACCOUNT_ID, "init");

    await page.route("**/*", async (route) => {
        if (await maybeFulfillMockWalletRequest(route)) {
            return;
        }

        const url = route.request().url();

        // Auth
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

        // Treasury creation status
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

        // User treasuries
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
                            name: "Requests E2E Test Treasury",
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

        // Treasury policy
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

        // Subscription
        if (url.includes("/api/subscription/")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(SUBSCRIPTION),
            });
        }

        // Assets
        if (url.includes("/api/user/assets") || url.includes("/user/assets")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(TREASURY_ASSETS),
            });
        }

        // Proposals — all queries return empty (new treasury)
        if (url.includes("/api/proposals/") || url.includes("/proposals/")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(EMPTY_PROPOSALS),
            });
        }

        // Monitored accounts
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

        return route.continue();
    });
}

test.describe("Requests page – new treasury with onboarding", () => {
    test("CTA buttons (Send / Exchange) do not overlap on requests page", async ({
        page,
    }) => {
        await setupRequestsPageMocks(page);

        // Register response listeners before navigation to avoid race
        const authResp = page.waitForResponse((r) =>
            r.url().includes("/auth/me"),
        );
        const proposalsResp = page.waitForResponse((r) =>
            r.url().includes("/proposals/"),
        );

        await page.goto(`/${TREASURY_ID}/requests`);
        await authResp;
        await proposalsResp;

        // Scope to main content to avoid matching sidebar nav buttons
        const main = page.locator("main");
        const sendButton = main.getByRole("button", { name: /send/i });
        const exchangeButton = main.getByRole("button", {
            name: /exchange/i,
        });

        await expect(sendButton).toBeVisible({ timeout: 15000 });
        await expect(exchangeButton).toBeVisible({ timeout: 15000 });

        // Screenshot: full page with the CTA buttons visible
        await page.screenshot({
            path: "test-results/requests-page-cta-buttons.png",
            fullPage: true,
        });

        // Verify buttons do NOT overlap by comparing bounding boxes
        const sendBox = await sendButton.boundingBox();
        const exchangeBox = await exchangeButton.boundingBox();

        expect(sendBox).not.toBeNull();
        expect(exchangeBox).not.toBeNull();

        if (sendBox && exchangeBox) {
            const horizontalOverlap =
                sendBox.x < exchangeBox.x + exchangeBox.width &&
                sendBox.x + sendBox.width > exchangeBox.x;
            const verticalOverlap =
                sendBox.y < exchangeBox.y + exchangeBox.height &&
                sendBox.y + sendBox.height > exchangeBox.y;

            const buttonsOverlap = horizontalOverlap && verticalOverlap;

            // Screenshot: zoomed-in on the CTA area
            const ctaContainer = page.locator(".flex.gap-4.w-\\[300px\\]");
            if (await ctaContainer.isVisible()) {
                await ctaContainer.screenshot({
                    path: "test-results/requests-page-cta-buttons-zoomed.png",
                });
            }

            expect(
                buttonsOverlap,
                `Send button (x:${sendBox.x}, y:${sendBox.y}, w:${sendBox.width}, h:${sendBox.height}) ` +
                    `overlaps with Exchange button (x:${exchangeBox.x}, y:${exchangeBox.y}, w:${exchangeBox.width}, h:${exchangeBox.height})`,
            ).toBe(false);

            // Verify there's a visible gap between them (at least 4px)
            const gap = exchangeBox.x - (sendBox.x + sendBox.width);
            expect(
                gap,
                `Gap between Send and Exchange buttons should be >= 4px, got ${gap}px`,
            ).toBeGreaterThanOrEqual(4);

            // Buttons with short labels should not stretch excessively wide
            const maxButtonWidth = 200;
            expect(
                sendBox.width,
                `Send button width (${sendBox.width}px) should be <= ${maxButtonWidth}px`,
            ).toBeLessThanOrEqual(maxButtonWidth);
            expect(
                exchangeBox.width,
                `Exchange button width (${exchangeBox.width}px) should be <= ${maxButtonWidth}px`,
            ).toBeLessThanOrEqual(maxButtonWidth);
        }
    });

    test("Requests page shows empty state with proper heading for new treasury", async ({
        page,
    }) => {
        await setupRequestsPageMocks(page);

        const authResp = page.waitForResponse((r) =>
            r.url().includes("/auth/me"),
        );
        const proposalsResp = page.waitForResponse((r) =>
            r.url().includes("/proposals/"),
        );

        await page.goto(`/${TREASURY_ID}/requests`);
        await authResp;
        await proposalsResp;

        // Verify empty-state heading
        await expect(page.getByText("Create your first request")).toBeVisible({
            timeout: 15000,
        });

        // Verify description text
        await expect(
            page.getByText(/requests for payments, exchanges/i),
        ).toBeVisible();

        // Screenshot: full empty-state view
        await page.screenshot({
            path: "test-results/requests-page-empty-state.png",
            fullPage: true,
        });
    });

    test("CTA buttons are not overlapped by onboarding progress on dashboard", async ({
        page,
    }) => {
        await setupRequestsPageMocks(page);

        const authResp = page.waitForResponse((r) =>
            r.url().includes("/auth/me"),
        );
        const assetsResp = page.waitForResponse((r) =>
            r.url().includes("/user/assets"),
        );

        // Navigate to dashboard (onboarding widget lives here)
        await page.goto(`/${TREASURY_ID}`);
        await authResp;
        await assetsResp;

        // Scope to main content to avoid matching sidebar nav buttons
        const main = page.locator("main");

        // Onboarding progress should be visible (step 3 is active since we have assets but no proposals)
        const onboardingHeading = main.getByText(/follow quick steps to/i);
        await expect(onboardingHeading).toBeVisible({ timeout: 15000 });

        // Screenshot: dashboard with onboarding
        await page.screenshot({
            path: "test-results/dashboard-onboarding-cta.png",
            fullPage: true,
        });

        // The "Send" button in onboarding step 3 should be visible (not the dashboard #dashboard-step2 one)
        const sendStepButton = main.locator("button:not(#dashboard-step2)", {
            hasText: /send/i,
        });
        await expect(sendStepButton).toBeVisible();
    });

    test("Requests page shows 'All caught up' with CTA buttons when all requests are executed", async ({
        page,
    }) => {
        const EXECUTED_PROPOSAL = {
            id: 1,
            proposalId: 1,
            daoId: TREASURY_ID,
            proposer: ACCOUNT_ID,
            kind: {
                Transfer: {
                    tokenId: "",
                    receiverId: "bob.near",
                    amount: "1000000000000000000000000",
                    msg: null,
                },
            },
            type: "Payments",
            status: "Approved",
            voteCounts: { council: [1, 0, 0] },
            votes: { [ACCOUNT_ID]: "Approve" },
            submissionTime: "1712000000000000000",
            description: "Payment to bob",
            txHash: "abc123",
        };

        const ALL_PROPOSALS = {
            page: 0,
            page_size: 15,
            total: 1,
            proposals: [EXECUTED_PROPOSAL],
        };

        // Override the default mock to distinguish between "all" and "pending" queries
        await page.route("**/*", (route) => {
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
                                name: "Requests E2E Test Treasury",
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

            if (
                url.includes("/api/user/assets") ||
                url.includes("/user/assets")
            ) {
                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(TREASURY_ASSETS),
                });
            }

            // Proposals: pending (InProgress) returns empty, all others return the executed proposal
            if (url.includes("/proposals/")) {
                const urlObj = new URL(url);
                const statuses = urlObj.searchParams.get("statuses");

                if (statuses?.includes("InProgress")) {
                    return route.fulfill({
                        status: 200,
                        contentType: "application/json",
                        body: JSON.stringify(EMPTY_PROPOSALS),
                    });
                }

                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify(ALL_PROPOSALS),
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

            return route.continue();
        });

        const authResp = page.waitForResponse((r) =>
            r.url().includes("/auth/me"),
        );
        const proposalsResp = page.waitForResponse((r) =>
            r.url().includes("/proposals/"),
        );

        await page.goto(`/${TREASURY_ID}/requests`);
        await authResp;
        await proposalsResp;

        const main = page.locator("main");

        // Should show "All caught up!" empty state (not the "Create your first request" state)
        await expect(main.getByText("All caught up!")).toBeVisible({
            timeout: 15000,
        });
        await expect(
            main.getByText(/there are no pending requests/i),
        ).toBeVisible();

        // Should NOT show the "Create your first request" empty state
        await expect(
            main.getByText("Create your first request"),
        ).not.toBeVisible();

        // CTA buttons should be visible and not overlapping
        const sendButton = main.getByRole("button", { name: /send/i });
        const exchangeButton = main.getByRole("button", {
            name: /exchange/i,
        });

        await expect(sendButton).toBeVisible();
        await expect(exchangeButton).toBeVisible();

        const sendBox = await sendButton.boundingBox();
        const exchangeBox = await exchangeButton.boundingBox();

        expect(sendBox).not.toBeNull();
        expect(exchangeBox).not.toBeNull();

        if (sendBox && exchangeBox) {
            const horizontalOverlap =
                sendBox.x < exchangeBox.x + exchangeBox.width &&
                sendBox.x + sendBox.width > exchangeBox.x;
            const verticalOverlap =
                sendBox.y < exchangeBox.y + exchangeBox.height &&
                sendBox.y + sendBox.height > exchangeBox.y;

            expect(
                horizontalOverlap && verticalOverlap,
                `Send and Exchange CTA buttons should not overlap`,
            ).toBe(false);

            // Buttons with short labels should not stretch excessively wide
            const maxButtonWidth = 200;
            expect(
                sendBox.width,
                `Send button width (${sendBox.width}px) should be <= ${maxButtonWidth}px`,
            ).toBeLessThanOrEqual(maxButtonWidth);
            expect(
                exchangeBox.width,
                `Exchange button width (${exchangeBox.width}px) should be <= ${maxButtonWidth}px`,
            ).toBeLessThanOrEqual(maxButtonWidth);
        }

        await page.screenshot({
            path: "test-results/requests-page-all-executed.png",
            fullPage: true,
        });
    });
});
