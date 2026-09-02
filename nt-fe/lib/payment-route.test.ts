import { describe, expect, it } from "bun:test";
import type { Token } from "@/components/token-input";
import {
    NEAR_COM_NETWORK_ID,
    NEAR_NETWORK_ID,
    NEP141_WRAP_NEAR_ASSET_ID,
} from "@/constants/network-ids";
import {
    NEP141_USDC_NEAR_ASSET_ID,
    USDC_NEAR_CONTRACT_ID,
} from "@/constants/token";
import { buildIntentsQuoteRequest } from "@/hooks/use-intents-quote";
import {
    classifyPaymentToken,
    normalizePaymentRecipient,
    shouldUseDirectPaymentTransfer,
} from "@/lib/payment-route";

const TREASURY_ID = "staging-qa.sputnik-dao.near";
const PROPOSAL_PERIOD = `${60 * 60 * 1_000_000_000}`;
const AMOUNT = "1000000";
const NEAR_ACCOUNT = "alice.near";
const ETH_RECIPIENT = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const ETH_USDC_QUOTE_ID =
    "1cs_v1:eth:erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const PUBLIC_NATIVE: Token = {
    symbol: "NEAR",
    address: NEAR_NETWORK_ID,
    network: NEAR_NETWORK_ID,
    decimals: 24,
    icon: "",
    name: "NEAR",
    residency: "Near",
};

const PUBLIC_FT: Token = {
    symbol: "USDC",
    address: USDC_NEAR_CONTRACT_ID,
    network: NEAR_NETWORK_ID,
    decimals: 6,
    icon: "",
    name: "USD Coin",
    residency: "Ft",
    balanceAssetId: USDC_NEAR_CONTRACT_ID,
};

const INTENTS_USDC: Token = {
    symbol: "USDC",
    address: NEP141_USDC_NEAR_ASSET_ID,
    network: NEAR_NETWORK_ID,
    decimals: 6,
    icon: "",
    name: "USD Coin",
    residency: "Intents",
    balanceAssetId: NEP141_USDC_NEAR_ASSET_ID,
};

const CONFIDENTIAL_NATIVE: Token = {
    symbol: "NEAR",
    address: NEP141_WRAP_NEAR_ASSET_ID,
    network: NEAR_NETWORK_ID,
    decimals: 24,
    icon: "",
    name: "NEAR",
    residency: "Intents",
    balanceAssetId: NEP141_WRAP_NEAR_ASSET_ID,
};

function quoteRequest(
    token: Token,
    isConfidential: boolean,
    destinationNetwork: string,
    recipient: string,
    destinationQuoteAssetId?: string,
) {
    const { tokenForIntentsQuote } = classifyPaymentToken(token);
    return buildIntentsQuoteRequest(
        TREASURY_ID,
        tokenForIntentsQuote,
        recipient,
        AMOUNT,
        isConfidential,
        PROPOSAL_PERIOD,
        "recipient",
        destinationNetwork,
        true,
        { destinationQuoteAssetId },
    );
}

describe("shouldUseDirectPaymentTransfer", () => {
    it("uses a direct transfer for public NEAR/FT to a NEAR account", () => {
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_NATIVE,
                destinationNetwork: NEAR_NETWORK_ID,
                recipient: NEAR_ACCOUNT,
                isConfidential: false,
            }),
        ).toBe(true);
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_FT,
                destinationNetwork: NEAR_NETWORK_ID,
                recipient: NEAR_ACCOUNT,
                isConfidential: false,
            }),
        ).toBe(true);
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_FT,
                destinationNetwork: NEAR_NETWORK_ID,
                recipient: ETH_RECIPIENT,
                isConfidential: false,
            }),
        ).toBe(true);
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_NATIVE,
                destinationNetwork: NEAR_NETWORK_ID,
                recipient: ETH_RECIPIENT,
                isConfidential: false,
            }),
        ).toBe(true);
    });

    it("quotes near.com, Intents tokens, and confidential", () => {
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_FT,
                destinationNetwork: NEAR_COM_NETWORK_ID,
                recipient: `nearcom:${NEAR_ACCOUNT}`,
                isConfidential: false,
            }),
        ).toBe(false);
        expect(
            shouldUseDirectPaymentTransfer({
                token: INTENTS_USDC,
                destinationNetwork: NEP141_USDC_NEAR_ASSET_ID,
                recipient: NEAR_ACCOUNT,
                isConfidential: false,
            }),
        ).toBe(false);
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_FT,
                destinationNetwork: NEAR_NETWORK_ID,
                recipient: NEAR_ACCOUNT,
                isConfidential: true,
            }),
        ).toBe(false);
        expect(
            shouldUseDirectPaymentTransfer({
                token: PUBLIC_FT,
                destinationNetwork: ETH_USDC_QUOTE_ID,
                recipient: ETH_RECIPIENT,
                isConfidential: false,
            }),
        ).toBe(false);
    });
});

describe("normalizePaymentRecipient", () => {
    it("strips nearcom: and lowercases eth-implicit 0x", () => {
        expect(normalizePaymentRecipient(`nearcom:${NEAR_ACCOUNT}`)).toBe(
            NEAR_ACCOUNT,
        );
        expect(
            normalizePaymentRecipient(
                "0xD7A7486Dba405cBd55FA685Dce53E6E2B755485B",
            ),
        ).toBe("0xd7a7486dba405cbd55fa685dce53e6e2b755485b");
    });
});

describe("buildIntentsQuoteRequest for payments", () => {
    it("prefixes a bare FT balanceAssetId without classify", () => {
        const request = buildIntentsQuoteRequest(
            TREASURY_ID,
            PUBLIC_FT,
            `nearcom:${NEAR_ACCOUNT}`,
            AMOUNT,
            false,
            PROPOSAL_PERIOD,
            "recipient",
            NEAR_COM_NETWORK_ID,
            true,
        );
        expect(request.originAsset).toBe(NEP141_USDC_NEAR_ASSET_ID);
        expect(request.destinationAsset).toBe(NEP141_USDC_NEAR_ASSET_ID);
    });

    it("prefixes public FT USDC → near.com", () => {
        const request = quoteRequest(
            PUBLIC_FT,
            false,
            NEAR_COM_NETWORK_ID,
            `nearcom:${NEAR_ACCOUNT}`,
        );
        expect(request).toMatchObject({
            originAsset: NEP141_USDC_NEAR_ASSET_ID,
            destinationAsset: NEP141_USDC_NEAR_ASSET_ID,
            depositType: "ORIGIN_CHAIN",
            recipientType: "INTENTS",
            recipient: NEAR_ACCOUNT,
        });
    });

    it("quotes public native NEAR → near.com as wrap.near", () => {
        const request = quoteRequest(
            PUBLIC_NATIVE,
            false,
            NEAR_COM_NETWORK_ID,
            `nearcom:${NEAR_ACCOUNT}`,
        );
        expect(request).toMatchObject({
            originAsset: NEP141_WRAP_NEAR_ASSET_ID,
            destinationAsset: NEP141_WRAP_NEAR_ASSET_ID,
            depositType: "ORIGIN_CHAIN",
            recipientType: "INTENTS",
        });
    });

    it("quotes Intents USDC to NEAR vs another chain", () => {
        const toNear = quoteRequest(
            INTENTS_USDC,
            false,
            NEP141_USDC_NEAR_ASSET_ID,
            NEAR_ACCOUNT,
            NEP141_USDC_NEAR_ASSET_ID,
        );
        expect(toNear).toMatchObject({
            originAsset: NEP141_USDC_NEAR_ASSET_ID,
            destinationAsset: NEP141_USDC_NEAR_ASSET_ID,
            depositType: "INTENTS",
            recipientType: "DESTINATION_CHAIN",
        });

        const toEth = quoteRequest(
            INTENTS_USDC,
            false,
            ETH_USDC_QUOTE_ID,
            ETH_RECIPIENT,
            ETH_USDC_QUOTE_ID,
        );
        expect(toEth).toMatchObject({
            originAsset: NEP141_USDC_NEAR_ASSET_ID,
            destinationAsset: ETH_USDC_QUOTE_ID,
            depositType: "INTENTS",
            recipientType: "DESTINATION_CHAIN",
        });
    });

    it("uses confidential deposit/recipient types", () => {
        const toNearCom = quoteRequest(
            CONFIDENTIAL_NATIVE,
            true,
            NEAR_COM_NETWORK_ID,
            `nearcom:${NEAR_ACCOUNT}`,
        );
        expect(toNearCom).toMatchObject({
            originAsset: NEP141_WRAP_NEAR_ASSET_ID,
            destinationAsset: NEP141_WRAP_NEAR_ASSET_ID,
            depositType: "CONFIDENTIAL_INTENTS",
            recipientType: "CONFIDENTIAL_INTENTS",
        });

        const toEth = quoteRequest(
            INTENTS_USDC,
            true,
            ETH_USDC_QUOTE_ID,
            ETH_RECIPIENT,
            ETH_USDC_QUOTE_ID,
        );
        expect(toEth).toMatchObject({
            originAsset: NEP141_USDC_NEAR_ASSET_ID,
            destinationAsset: ETH_USDC_QUOTE_ID,
            depositType: "CONFIDENTIAL_INTENTS",
            recipientType: "DESTINATION_CHAIN",
        });
    });

    it("confidentialRecipient keeps a public origin but delivers confidentially", () => {
        const { tokenForIntentsQuote } = classifyPaymentToken(PUBLIC_NATIVE);
        const request = buildIntentsQuoteRequest(
            TREASURY_ID,
            tokenForIntentsQuote,
            TREASURY_ID,
            AMOUNT,
            false,
            PROPOSAL_PERIOD,
            "total",
            NEAR_COM_NETWORK_ID,
            true,
            { confidentialRecipient: true },
        );
        expect(request).toMatchObject({
            swapType: "EXACT_INPUT",
            depositType: "ORIGIN_CHAIN",
            refundType: "ORIGIN_CHAIN",
            refundTo: TREASURY_ID,
            recipient: TREASURY_ID,
            recipientType: "CONFIDENTIAL_INTENTS",
        });

        // Off the near.com route the option must not touch the recipient type.
        const toEth = buildIntentsQuoteRequest(
            TREASURY_ID,
            tokenForIntentsQuote,
            ETH_RECIPIENT,
            AMOUNT,
            false,
            PROPOSAL_PERIOD,
            "total",
            ETH_USDC_QUOTE_ID,
            true,
            {
                destinationQuoteAssetId: ETH_USDC_QUOTE_ID,
                confidentialRecipient: true,
            },
        );
        expect(toEth.recipientType).toBe("DESTINATION_CHAIN");
    });
});
