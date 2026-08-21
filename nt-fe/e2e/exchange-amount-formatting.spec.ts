import { expect, type Page, test } from "@playwright/test";
import {
    maybeFulfillMockWalletRequest,
    seedMockWalletAccount,
} from "./helpers/mock-wallet";

const TREASURY_ID = "requests-e2e-test.sputnik-dao.near";
const ACCOUNT_ID = "test.near";
const FUTURE_DEADLINE = "2099-01-01T00:00:00.000Z";

const POLICY = {
    roles: [
        {
            name: "council",
            kind: { Group: [ACCOUNT_ID] },
            permissions: ["*:AddProposal"],
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

const ASSETS = [
    {
        id: "nep141:btc.omft.near",
        contractId: "nep141:btc.omft.near",
        residency: "Intents",
        network: "bitcoin",
        chainName: "Bitcoin",
        symbol: "BTC",
        balance: { Standard: { total: "100000000", locked: "0" } },
        decimals: 8,
        price: "100000",
        name: "Bitcoin",
        icon: "",
        chainIcons: { icon: "" },
    },
];

const BRIDGE_ASSETS = [
    {
        id: "btc",
        name: "Bitcoin",
        icon: "",
        networks: [
            {
                id: "nep141:btc.omft.near",
                name: "Bitcoin",
                symbol: "BTC",
                chainIcons: { icon: "" },
                chainId: "bitcoin",
                decimals: 8,
            },
        ],
    },
    {
        id: "eth",
        name: "Ethereum",
        icon: "",
        networks: [
            {
                id: "nep141:eth.omft.near",
                name: "Ethereum",
                symbol: "ETH",
                chainIcons: { icon: "" },
                chainId: "eth",
                decimals: 18,
            },
        ],
    },
];

async function setupExchangeMocks(page: Page) {
    await seedMockWalletAccount(page, ACCOUNT_ID, "init");
    await page.addInitScript(() => {
        localStorage.setItem("exchange-settings-tour-shown:v1", "true");
    });

    await page.route("**/*", async (route) => {
        if (await maybeFulfillMockWalletRequest(route)) return;

        const url = route.request().url();
        const json = (body: unknown) =>
            route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(body),
            });

        if (url.includes("/auth/me")) {
            return json({ accountId: ACCOUNT_ID, termsAccepted: true });
        }
        if (url.includes("/treasury/creation-status")) {
            return json({ creationAvailable: true });
        }
        if (url.includes("/user/treasuries")) {
            return json([
                {
                    daoId: TREASURY_ID,
                    config: { name: "Exchange Amount Test", metadata: {} },
                    isMember: true,
                    isSaved: true,
                    isHidden: false,
                },
            ]);
        }
        if (url.includes("/treasury/policy")) return json(POLICY);
        if (url.includes("/user/assets")) return json(ASSETS);
        if (
            url.includes("/intents/deposit-tokens") ||
            url.includes("/intents/swap-tokens") ||
            url.includes("/intents/bridge-tokens")
        ) {
            return json({ assets: BRIDGE_ASSETS });
        }
        if (url.includes("/warnings")) return json({ warnings: [] });
        if (url.includes("/subscription/")) {
            return json({
                accountId: TREASURY_ID,
                planType: "free",
                planConfig: {
                    planType: "free",
                    limits: { gasCoveredTransactions: null },
                    pricing: {},
                },
                exportCredits: 10,
                batchPaymentCredits: 10,
                gasCoveredTransactions: 100,
            });
        }
        if (url.includes("/monitored-accounts")) {
            return json({ accountId: TREASURY_ID, enabled: true });
        }
        if (url.includes("/intents/quote")) {
            const request = route.request().postDataJSON();
            return json({
                quote: {
                    amountIn: "5000000",
                    amountInFormatted: "0.05",
                    amountInUsd: "5000",
                    minAmountIn: "5000000",
                    amountOut: "5000000000000000000000",
                    amountOutFormatted: "5,000",
                    amountOutUsd: "5000",
                    minAmountOut: "4990000000000000000000",
                    timeEstimate: 30,
                    depositAddress: "exchange-test-deposit.near",
                    deadline: FUTURE_DEADLINE,
                    timeWhenInactive: FUTURE_DEADLINE,
                },
                quoteRequest: {
                    ...request,
                    deadline: FUTURE_DEADLINE,
                },
                signature: "test-signature",
                timestamp: new Date().toISOString(),
                correlationId: "exchange-amount-formatting",
            });
        }

        return route.continue();
    });
}

for (const viewport of [
    { name: "desktop", width: 1280, height: 800 },
    { name: "mobile", width: 390, height: 844 },
] as const) {
    test(`keeps grouped quote displays out of exchange data on ${viewport.name}`, async ({
        page,
    }) => {
        await page.setViewportSize(viewport);
        await setupExchangeMocks(page);
        const pageErrors: Error[] = [];
        page.on("pageerror", (error) => pageErrors.push(error));

        await page.goto(`/${TREASURY_ID}/exchange`);

        const amountInputs = page.locator('input[inputmode="decimal"]');
        await expect(amountInputs).toHaveCount(2, { timeout: 15_000 });
        await amountInputs.first().fill("0.05");
        await expect(amountInputs.nth(1)).toHaveValue("5000", {
            timeout: 15_000,
        });

        await page.getByRole("button", { name: /^Review Exchange$/i }).click();
        await expect(page.getByText("5,000 ETH", { exact: true })).toBeVisible({
            timeout: 15_000,
        });
        const unexpectedPageErrors = pageErrors.filter(
            (error) =>
                !error.message.includes(
                    "document is sandboxed and lacks the 'allow-same-origin' flag",
                ),
        );
        expect(unexpectedPageErrors).toEqual([]);
    });
}
