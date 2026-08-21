/**
 * E2E test for confidential treasury deposits.
 *
 * Verifies the redesigned deposit page flow:
 * 1. Create a confidential DAO on sandbox
 * 2. Navigate to the dashboard
 * 3. Open the deposit page from dashboard action
 * 4. Choose "From a public wallet", select asset/network
 * 5. Acknowledge + Generate Address → one-time intents address
 * 6. Switch to confidential user path and show treasury address
 *
 * Bridge/catalog RPC (deposit-tokens, swap-tokens, deposit-address) is mocked at the Playwright
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
                    minDepositAmount: "5000000",
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

    await ensureTreasury({
        name: "Confidential Deposit Test",
        accountId: DAO_ID,
        governors: [ACCOUNT_ID],
        financiers: [ACCOUNT_ID],
        requestors: [ACCOUNT_ID],
        isConfidential: true,
    });

    await transferNear("near", DAO_ID, 10);

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

test("Confidential deposit — dashboard deposit page flow", async ({
    page,
    context,
}) => {
    test.setTimeout(180_000);

    const sandboxJwt = await setupSandbox();

    let depositAddressRequested = false;

    await context.route("http://localhost:8080/**", async (route) => {
        const url = route.request().url();

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

        if (
            url.includes("/api/intents/deposit-tokens") ||
            url.includes("/api/intents/swap-tokens") ||
            url.includes("/api/intents/bridge-tokens")
        ) {
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(MOCK_BRIDGE_TOKENS),
            });
        }

        if (url.includes("/api/intents/deposit-address")) {
            depositAddressRequested = true;
            return route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    address: MOCK_DEPOSIT_ADDRESS,
                    memo: null,
                    minAmount: "5000000",
                    expiresAt: new Date(
                        Date.now() + 14 * 24 * 60 * 60 * 1000,
                    ).toISOString(),
                }),
            });
        }

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

    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.log(`[BROWSER ERROR] ${msg.text()}`);
        }
    });
    page.on("pageerror", (err) => {
        console.log(`[PAGE ERROR] ${err.message}`);
    });

    await page.goto(`/${DAO_ID}`);
    await seedMockWalletAccount(page, ACCOUNT_ID, "evaluate");
    await page.goto(`/${DAO_ID}`);

    const depositButton = page.locator("#dashboard-step1");
    await expect(depositButton).toBeVisible({ timeout: 15_000 });
    await expect(depositButton).toContainText("Receive");

    await depositButton.click();
    await expect(page).toHaveURL(new RegExp(`/${DAO_ID}/dashboard/deposit`), {
        timeout: 10_000,
    });

    await expect(page.getByRole("heading", { name: "Receive" })).toBeVisible({
        timeout: 10_000,
    });

    // Source cards appear first for confidential treasuries
    const publicSource = page.getByTestId("deposit-source-public_wallet");
    const confidentialSource = page.getByTestId(
        "deposit-source-confidential_user",
    );
    await expect(publicSource).toBeVisible({ timeout: 10_000 });
    await expect(confidentialSource).toBeVisible({ timeout: 10_000 });

    await expect(
        page.getByText("Select token and network to see deposit address"),
    ).toBeVisible();

    const assetSelectButton = page.getByTestId("deposit-asset-selector");
    await expect(assetSelectButton).toBeVisible({ timeout: 10_000 });
    await assetSelectButton.click();
    await expect(
        page.getByRole("heading", { name: "Select token" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
        .getByRole("button", { name: /USD Coin/i })
        .first()
        .click();

    const networkSelectButton = page.getByTestId("deposit-network-selector");
    await expect(networkSelectButton).toBeVisible({ timeout: 10_000 });
    await networkSelectButton.click();
    await expect(
        page.getByRole("heading", { name: "Select network" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "Near Protocol" }).first().click();

    // Address must NOT be fetched until Generate Address is clicked
    expect(depositAddressRequested).toBe(false);

    await expect(page.getByTestId("deposit-ack-checkbox")).toBeVisible({
        timeout: 10_000,
    });
    const generateButton = page.getByTestId("deposit-ack-cta");
    await expect(generateButton).toBeDisabled();

    await page.getByTestId("deposit-ack-checkbox").click();
    await expect(generateButton).toBeEnabled();
    await generateButton.click();

    await expect(
        page.getByText(/One-time deposit address/i).first(),
    ).toBeVisible({ timeout: 15_000 });

    const publicAddressElement = page.locator("code").first();
    await expect(publicAddressElement).toBeVisible({ timeout: 10_000 });
    const publicAddressText = await publicAddressElement.textContent();
    expect(publicAddressText).toContain(MOCK_DEPOSIT_ADDRESS.slice(0, 6));
    expect(publicAddressText).not.toContain(DAO_ID);
    expect(depositAddressRequested).toBe(true);

    await expect(page.getByText(/Expires in/i)).toBeVisible();

    // Return to select, then switch to confidential user source
    await page.goto(`/${DAO_ID}/dashboard/deposit`);
    await expect(confidentialSource).toBeVisible({ timeout: 10_000 });
    await confidentialSource.click();

    await expect(page.getByTestId("deposit-ack-checkbox")).toBeVisible({
        timeout: 10_000,
    });
    const showAddressButton = page.getByTestId("deposit-ack-cta");
    await expect(showAddressButton).toBeDisabled();
    await page.getByTestId("deposit-ack-checkbox").click();
    await expect(showAddressButton).toBeEnabled();
    await showAddressButton.click();

    await expect(
        page.getByText(/Deposit address any asset on near.com/i),
    ).toBeVisible({ timeout: 10_000 });

    const confidentialAddressElement = page.locator("code").first();
    await expect(confidentialAddressElement).toBeVisible({ timeout: 10_000 });
    expect(await confidentialAddressElement.textContent()).toContain(DAO_ID);

    await expect(page.locator("svg").first()).toBeVisible();

    // Verify "Other" asset is not available on public-wallet path
    await page.goto(`/${DAO_ID}/dashboard/deposit`);
    await publicSource.click();
    const selectedAssetButton = page.getByTestId("deposit-asset-selector");
    await expect(selectedAssetButton).toBeVisible({ timeout: 10_000 });
    await selectedAssetButton.click();
    await expect(
        page.getByRole("heading", { name: "Select token" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole("button", { name: /^Other$/i })).toHaveCount(0);
});
