import { test, expect, type Page } from "@playwright/test";
import {
    maybeFulfillMockWalletRequest,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

const TREASURY_ID = "onboarding-e2e-test.sputnik-dao.near";
const ACCOUNT_ID = "test.near";
const ESCAPED_TREASURY = TREASURY_ID.replaceAll(".", "\\.");

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

test.use({ locale: "en-US" });
test.describe.configure({ timeout: 120_000 });

type AuthState = { authenticated: boolean };

async function setupTreasuryMocks(
    page: Page,
    options: { authenticated: boolean },
): Promise<AuthState> {
    const authState: AuthState = { authenticated: options.authenticated };

    if (options.authenticated) {
        await seedMockWalletAccount(page, ACCOUNT_ID, "init");
    }

    await page.route("**/*", async (route) => {
        if (await maybeFulfillMockWalletRequest(route)) {
            return;
        }

        const url = route.request().url();

        if (url.includes("/api/auth/me") || url.includes("/auth/me")) {
            if (authState.authenticated) {
                return route.fulfill({
                    status: 200,
                    contentType: "application/json",
                    body: JSON.stringify({
                        accountId: ACCOUNT_ID,
                        termsAccepted: true,
                    }),
                });
            }
            return route.fulfill({
                status: 401,
                contentType: "application/json",
                body: JSON.stringify({ error: "Not authenticated" }),
            });
        }

        if (url.includes("/api/auth/logout") || url.includes("/auth/logout")) {
            authState.authenticated = false;
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ ok: true }),
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
                body: JSON.stringify(
                    authState.authenticated
                        ? [
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
                                  isConfidential: false,
                              },
                          ]
                        : [],
                ),
            });
        }

        if (
            url.includes("/api/treasury/config") ||
            url.includes("/treasury/config")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    name: "Onboarding E2E Test Treasury",
                    purpose: "Testing",
                    metadata: {},
                    isConfidential: false,
                }),
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
                body: JSON.stringify([]),
            });
        }

        if (url.includes("/api/proposals/") || url.includes("/proposals/")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    page: 0,
                    page_size: 15,
                    total: 0,
                    proposals: [],
                }),
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

        if (url.includes("/deposit-tokens") || url.includes("/swap-tokens")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ assets: [] }),
            });
        }

        return route.continue();
    });

    return authState;
}

function expectLoginWithReturnTo(page: Page, pathFragment: string) {
    return (async () => {
        await expect(page).toHaveURL(/\/login\?/, { timeout: 30_000 });
        const decoded = decodeURIComponent(page.url());
        expect(decoded).toContain(pathFragment);
    })();
}

test.describe("Auth redirect", () => {
    test("logged-out dashboard visit redirects to login with returnTo", async ({
        page,
    }) => {
        await setupTreasuryMocks(page, { authenticated: false });

        await page.goto(`/${TREASURY_ID}/dashboard`);

        await expectLoginWithReturnTo(page, `/${TREASURY_ID}/dashboard`);
        await expect(page.getByText("Get started")).not.toBeVisible();
    });

    test("after sign-in, returns to the original dashboard URL", async ({
        page,
    }) => {
        const authState = await setupTreasuryMocks(page, {
            authenticated: false,
        });

        await page.goto(`/${TREASURY_ID}/dashboard`);
        await expectLoginWithReturnTo(page, `/${TREASURY_ID}/dashboard`);

        authState.authenticated = true;
        await seedMockWalletAccount(page, ACCOUNT_ID, "evaluate");
        await page.reload();

        await expect(page).toHaveURL(
            new RegExp(`/${ESCAPED_TREASURY}/dashboard`),
            { timeout: 30_000 },
        );
    });

    test("logged-out deep link preserves query in returnTo", async ({
        page,
    }) => {
        const authState = await setupTreasuryMocks(page, {
            authenticated: false,
        });

        await page.goto(`/${TREASURY_ID}/settings?tab=voting`);
        await expectLoginWithReturnTo(page, `/${TREASURY_ID}/settings`);
        expect(decodeURIComponent(page.url())).toContain("tab=voting");

        authState.authenticated = true;
        await seedMockWalletAccount(page, ACCOUNT_ID, "evaluate");
        await page.reload();

        await expect(page).toHaveURL(
            new RegExp(`/${ESCAPED_TREASURY}/settings\\?tab=voting`),
            { timeout: 30_000 },
        );
    });

    test("pay share link stays public without login", async ({ page }) => {
        await setupTreasuryMocks(page, { authenticated: false });

        await page.goto(
            `/${TREASURY_ID}/pay/public?id=test-deposit-address&network=near&token=near`,
        );

        await expect(page).toHaveURL(/\/pay\/public/, { timeout: 30_000 });
        await expect(page).not.toHaveURL(/\/login/);
    });

    test("disconnect from a treasury page redirects to login", async ({
        page,
    }) => {
        await setupTreasuryMocks(page, { authenticated: true });

        await page.goto(`/${TREASURY_ID}/dashboard`);
        await expect(page).toHaveURL(
            new RegExp(`/${ESCAPED_TREASURY}/dashboard`),
            { timeout: 30_000 },
        );

        // Header SignIn popover (desktop) or profile menu — open then sign out
        await page.getByText(ACCOUNT_ID, { exact: false }).first().click();
        await page
            .getByRole("button", { name: /log out|sign out|disconnect/i })
            .click();

        await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
    });
});
