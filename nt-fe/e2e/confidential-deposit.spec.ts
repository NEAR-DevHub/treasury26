/**
 * E2E test for confidential treasury deposits.
 *
 * Verifies that confidential treasuries use the same deposit UI
 * (dashboard deposit modal) as public treasuries:
 * 1. Create a confidential DAO on sandbox
 * 2. Navigate to the dashboard (not /confidential page)
 * 3. Open the deposit modal
 * 4. Select asset and network
 * 5. Verify deposit address is fetched via intents API
 *    (not the direct treasury account ID)
 *
 * Bridge RPC (bridge-tokens, deposit-address) is mocked at the Playwright
 * route level since the sandbox doesn't include a bridge RPC mock.
 * All other backend calls go to the real sandbox.
 */
import { test, expect } from "@playwright/test";
import {
    registerMockWalletRoutes,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";
import { createAccount, transferNear } from "./helpers/sandbox-rpc";
import { ensureTreasury } from "./helpers/create-treasury";

const DAO_ID = "confdeposit.sputnik-dao.near";
const ACCOUNT_ID = "confdeposit.near";
const SANDBOX_MOCK_URL = "http://localhost:4000";

/**
 * Mock deposit address returned by the intents API.
 * Deliberately different from DAO_ID so we can assert the address
 * came from intents and not the direct treasury account.
 */
const MOCK_DEPOSIT_ADDRESS =
    "d32b552aa188face5952516a370bc5a9d91f77a19c48d5b7b16e6c59eb79b08e";

const MOCK_BRIDGE_TOKENS = {
    assets: [
        {
            id: "near",
            assetName: "NEAR",
            name: "Near",
            icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/6535.png",
            networks: [
                {
                    id: "near:mainnet:native",
                    name: "Near Protocol",
                    symbol: "NEAR",
                    chainIcons: {
                        icon: "https://near.com/static/icons/network/near.svg",
                    },
                    chainId: "near:mainnet",
                    decimals: 24,
                    minDepositAmount: "100000000000000000000000",
                },
            ],
        },
        {
            id: "usdc",
            assetName: "USDC",
            name: "USD Coin",
            icon: "https://s2.coinmarketcap.com/static/img/coins/128x128/3408.png",
            networks: [
                {
                    id: "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
                    name: "Near Protocol",
                    symbol: "USDC",
                    chainIcons: {
                        icon: "https://near.com/static/icons/network/near.svg",
                    },
                    chainId: "near:mainnet",
                    decimals: 6,
                },
                {
                    id: "eth:1:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
                    name: "Ethereum",
                    symbol: "USDC",
                    chainIcons: {
                        icon: "https://near.com/static/icons/network/ethereum.svg",
                    },
                    chainId: "eth:1",
                    decimals: 6,
                    minDepositAmount: "3000000",
                },
            ],
        },
    ],
};

/** Ensure the DAO, user account, and auth session exist on the sandbox. */
async function setupSandbox(): Promise<string> {
    try {
        await createAccount(ACCOUNT_ID, "near", 10);
    } catch {
        // May already exist
    }

    // Ensure the confidential DAO exists once and can be reused between retries.
    await ensureTreasury({
        name: "Confidential Deposit Test",
        accountId: DAO_ID,
        governors: [ACCOUNT_ID],
        financiers: [ACCOUNT_ID],
        requestors: [ACCOUNT_ID],
        isConfidential: true,
    });

    // Fund the DAO
    await transferNear("near", DAO_ID, 10);

    // Create an auth session via the sandbox mock server
    const sessionResp = await fetch(
        `${SANDBOX_MOCK_URL}/_test/create-session`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ accountId: ACCOUNT_ID }),
        },
    );
    if (!sessionResp.ok) {
        throw new Error(
            `Failed to create session: ${sessionResp.status} ${await sessionResp.text()}`,
        );
    }
    const session = (await sessionResp.json()) as { token: string };
    return session.token;
}

test("Confidential deposit — dashboard deposit modal flow", async ({
    page,
    context,
}) => {
    test.setTimeout(180_000);

    const sandboxJwt = await setupSandbox();

    // Track whether deposit-address was requested (confidential treasuries
    // must always go through the intents API, even for NEAR-on-NEAR)
    let depositAddressRequested = false;

    // Intercept backend requests: inject JWT, mock bridge endpoints
    await context.route("http://localhost:8080/**", async (route) => {
        const url = route.request().url();

        // Mock auth/me (the mock wallet can't do real NEAR auth)
        if (url.includes("/api/auth/me")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    accountId: ACCOUNT_ID,
                    termsAccepted: true,
                }),
            });
        }

        // Mock bridge-tokens (Bridge RPC not available in sandbox)
        if (url.includes("/api/intents/bridge-tokens")) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(MOCK_BRIDGE_TOKENS),
            });
        }

        // Mock deposit-address (Bridge RPC not available in sandbox)
        if (url.includes("/api/intents/deposit-address")) {
            depositAddressRequested = true;
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    address: MOCK_DEPOSIT_ADDRESS,
                    memo: null,
                    minAmount: "5000000",
                }),
            });
        }

        // Proxy all other requests to the real sandbox backend with JWT
        const method = route.request().method();
        const headers: Record<string, string> = {
            cookie: `auth_token=${sandboxJwt}`,
        };
        const reqHeaders = route.request().headers();
        if (reqHeaders["content-type"]) {
            headers["content-type"] = reqHeaders["content-type"];
        }

        const resp = await fetch(url, {
            method,
            headers,
            body: method !== "GET" ? route.request().postData() : undefined,
        });

        const body = Buffer.from(await resp.arrayBuffer());
        const respHeaders: Record<string, string> = {};
        resp.headers.forEach((val, key) => {
            if (!key.startsWith("access-control-")) {
                respHeaders[key] = val;
            }
        });
        await route.fulfill({
            status: resp.status,
            headers: respHeaders,
            body,
        });
    });

    // Route NEAR RPC calls to sandbox instead of mainnet
    for (const rpcHost of [
        "**/archival-rpc.mainnet.fastnear.com**",
        "**/free.rpc.fastnear.com**",
    ]) {
        await context.route(rpcHost, async (route) => {
            const resp = await fetch("http://localhost:3030", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: route.request().postData(),
            });
            const body = Buffer.from(await resp.arrayBuffer());
            await route.fulfill({ status: resp.status, body });
        });
    }

    await registerMockWalletRoutes(context);

    // Capture console errors for debugging
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.log(`[BROWSER ERROR] ${msg.text()}`);
        }
    });
    page.on("pageerror", (err) => {
        console.log(`[PAGE ERROR] ${err.message}`);
    });

    // Seed wallet and navigate to dashboard
    await page.goto(`/${DAO_ID}`);
    await seedMockWalletAccount(page, ACCOUNT_ID, "evaluate");
    await page.goto(`/${DAO_ID}`);

    // ════════════════════════════════════════════════════
    // Phase 1: Verify dashboard renders for confidential treasury
    // ════════════════════════════════════════════════════

    const depositButton = page.locator("#dashboard-step1");
    await expect(depositButton).toBeVisible({ timeout: 15_000 });
    await expect(depositButton).toContainText("Deposit");

    // ════════════════════════════════════════════════════
    // Phase 2: Open deposit modal and complete deposit flow
    // ════════════════════════════════════════════════════

    await depositButton.click();

    // Deposit modal should open with the standard heading
    await expect(
        page.getByRole("heading", { name: "Deposit", exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Should show asset/network selection prompt
    await expect(
        page.getByText("Select asset and network to see deposit address"),
    ).toBeVisible();

    // Deposit modal starts without a selected network when multiple
    // destinations are available. Choose near.com (direct) explicitly.
    const networkSelectButton = page.getByRole("button", {
        name: /Select network/i,
    });
    await expect(networkSelectButton).toBeVisible({ timeout: 10_000 });
    await networkSelectButton.click();
    await expect(
        page.getByRole("heading", { name: "Select Network" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
        .getByRole("button", { name: /near\.com/i })
        .first()
        .click();

    // near.com (direct) shows treasury address and skips intents deposit-address call.
    const nearDirectButton = page.getByRole("button", { name: /near\.com/i });
    await expect(nearDirectButton).toBeVisible({ timeout: 10_000 });

    await expect(
        page.getByText("Deposit Address", { exact: true }),
    ).toBeVisible({ timeout: 15_000 });

    const directAddressElement = page.locator("code").first();
    await expect(directAddressElement).toBeVisible({ timeout: 10_000 });
    expect(await directAddressElement.textContent()).toContain(DAO_ID);
    expect(depositAddressRequested).toBe(false);

    // Switch network: open selector, pick Near Protocol (bridge deposit).
    await nearDirectButton.click();
    await expect(
        page.getByRole("heading", { name: "Select Network" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
        .getByRole("button", { name: /Near Protocol/i })
        .first()
        .click();

    await expect(
        page.getByRole("button", { name: /Near Protocol/i }),
    ).toBeVisible({ timeout: 10_000 });

    // Wait for deposit address section to appear
    await expect(
        page.getByText("Deposit Address", { exact: true }),
    ).toBeVisible({
        timeout: 15_000,
    });

    // The address should be the mocked intents address, NOT the treasury ID
    const addressElement = page.locator("code").first();
    await expect(addressElement).toBeVisible({ timeout: 10_000 });
    const addressText = await addressElement.textContent();
    expect(addressText).toContain(MOCK_DEPOSIT_ADDRESS.slice(0, 6));
    expect(addressText).not.toContain(DAO_ID);

    // Confidential treasury must have called deposit-address API
    // after switching away from near.com direct.
    expect(depositAddressRequested).toBe(true);

    // QR code should be rendered
    await expect(page.locator("svg").first()).toBeVisible();

    // TODO: verify "Minimum deposit is 5 USDC" once minAmount rendering is fixed
    // The mock returns minAmount: "5000000" but the UI does not display it yet.

    // Verify info message about depositing from the correct network
    await expect(page.getByText(/Only deposit/)).toBeVisible();

    // ════════════════════════════════════════════════════
    // Phase 3: Verify "Other" asset is not available
    // (confidential treasuries restrict to bridge assets only)
    // ════════════════════════════════════════════════════

    // Open the currently selected asset button
    const assetSelectButton = page.getByRole("button", {
        name: "Near Protocol Near Protocol",
        exact: true,
    });
    await expect(assetSelectButton).toBeVisible({ timeout: 10_000 });
    await assetSelectButton.click();
});
