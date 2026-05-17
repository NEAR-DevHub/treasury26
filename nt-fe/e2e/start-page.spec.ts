import { test, expect, type Page } from "@playwright/test";
import {
    maybeFulfillMockWalletRequest,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

test.use({
    actionTimeout: 60_000,
    navigationTimeout: 60_000,
});

async function setupStartPageMocks(
    page: Page,
    {
        accountId,
        creationAvailable,
        treasuries,
    }: {
        accountId?: string;
        creationAvailable: boolean;
        treasuries?: unknown[];
    },
) {
    if (accountId) {
        await seedMockWalletAccount(page, accountId, "init");
    }

    await page.route("**/*", async (route) => {
        const url = route.request().url();
        if (await maybeFulfillMockWalletRequest(route)) {
            return;
        }

        if (url.includes("/api/auth/me") || url.includes("/auth/me")) {
            return route.fulfill({
                status: accountId ? 200 : 401,
                contentType: "application/json",
                body: accountId
                    ? JSON.stringify({ accountId, termsAccepted: true })
                    : JSON.stringify({ error: "Not authenticated" }),
            });
        }

        if (
            url.includes("/api/treasury/creation-status") ||
            url.includes("/treasury/creation-status")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({ creationAvailable }),
            });
        }

        if (
            url.includes("/api/user/treasuries") ||
            url.includes("/user/treasuries")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(treasuries ?? []),
            });
        }

        return route.continue();
    });
}

async function gotoStartPageAndWaitForBootstrapRequests(page: Page) {
    const authMeResponse = page.waitForResponse((response) =>
        response.url().includes("/auth/me"),
    );
    const userTreasuriesResponse = page.waitForResponse((response) =>
        response.url().includes("/user/treasuries"),
    );

    await page.goto("/");
    await Promise.all([authMeResponse, userTreasuriesResponse]);
}

test("Start page shows onboarding choices when signed out", async ({
    page,
}) => {
    await setupStartPageMocks(page, { creationAvailable: true });

    await page.goto("/");

    await expect(
        page.getByRole("button", { name: /I.?m new to Trezu/i }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: /I already use Trezu/i }),
    ).toBeVisible();
});

test("Signed in + no treasuries + new user selection => redirects to /app/new?entry=new_user", async ({
    page,
}) => {
    await setupStartPageMocks(page, {
        accountId: "test.near",
        creationAvailable: true,
        treasuries: [],
    });

    await gotoStartPageAndWaitForBootstrapRequests(page);

    // New flow: /app/new redirect happens after explicitly choosing new user.
    await page
        .getByRole("button", {
            name: /I.?m new to Trezu/i,
        })
        .click();

    await expect(page).toHaveURL(/\/app\/new\?entry=new_user$/, {
        timeout: 15000,
    });
});

test("Signed in + has treasury => redirects to /{daoId}", async ({ page }) => {
    const daoId = "webassemblymusic-treasury.sputnik-dao.near";
    await setupStartPageMocks(page, {
        accountId: "test.near",
        creationAvailable: true,
        treasuries: [
            {
                daoId,
                config: { name: "My Treasury" },
                isMember: true,
                isSaved: true,
                isHidden: false,
            },
        ],
    });

    await gotoStartPageAndWaitForBootstrapRequests(page);

    await expect(page).toHaveURL(
        new RegExp(`/${daoId.replaceAll(".", "\\.")}$`),
        { timeout: 15000 },
    );
});

test("Signed in + no treasuries + creation disabled => waitlist is shown", async ({
    page,
}) => {
    await setupStartPageMocks(page, {
        accountId: "test.near",
        creationAvailable: false,
        treasuries: [],
    });

    await gotoStartPageAndWaitForBootstrapRequests(page);

    await expect(page).toHaveURL(/\/$/);
    await expect(
        page.getByRole("heading", { name: /join the trezu waitlist/i }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: /join the waitlist/i }),
    ).toBeVisible();
});
