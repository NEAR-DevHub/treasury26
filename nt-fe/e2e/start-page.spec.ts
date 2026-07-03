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
        treasuries,
    }: {
        accountId?: string;
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

test("Create route shows create treasury form when signed out", async ({
    page,
}) => {
    await setupStartPageMocks(page, {});

    await page.goto("/create");

    await expect(
        page.getByRole("heading", { name: /create treasury/i }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: /continue to wallet/i }),
    ).toBeVisible();
});

test("Signed in + no treasuries => stays on create treasury form", async ({
    page,
}) => {
    await setupStartPageMocks(page, {
        accountId: "test.near",
        treasuries: [],
    });

    await gotoStartPageAndWaitForBootstrapRequests(page);

    await expect(page).toHaveURL(/\/$/, { timeout: 15000 });
    await expect(
        page.getByRole("button", { name: /create treasury/i }),
    ).toBeVisible();
});

test("Signed in + has treasury => redirects to /{daoId}", async ({ page }) => {
    const daoId = "webassemblymusic-treasury.sputnik-dao.near";
    await setupStartPageMocks(page, {
        accountId: "test.near",
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
        treasuries: [],
    });

    await page.route("**/api/treasury/check-handle-unused**", async (route) =>
        route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ unused: true }),
        }),
    );
    // A permanent error (creation disabled) is not resumable, so the UI skips
    // the in-session recovery re-drives and falls straight through to the
    // waitlist. A transient error would instead spin for the full recovery
    // window before showing the waitlist.
    await page.route("**/api/treasury/create-stream", async (route) =>
        route.fulfill({
            status: 200,
            headers: { "content-type": "text/event-stream" },
            body: `data: {"step":"error","status":"error","message":"Treasury creation disabled"}\n\n`,
        }),
    );

    await gotoStartPageAndWaitForBootstrapRequests(page);

    await page.getByRole("button", { name: /public best for daos/i }).click();
    await page
        .getByRole("textbox", { name: "My Treasury" })
        .fill("testing-by-playwright");
    await page.getByRole("button", { name: /create treasury/i }).click();

    await expect(page).toHaveURL(/create/);
    await expect(
        page.getByRole("heading", { name: /give us a little time/i }),
    ).toBeVisible();
    await expect(
        page.getByRole("button", { name: /notify me/i }),
    ).toBeVisible();
});
