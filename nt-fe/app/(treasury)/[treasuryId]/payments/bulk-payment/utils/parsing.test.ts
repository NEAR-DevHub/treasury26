import { describe, expect, it } from "bun:test";
import { parseAmount, parseAndValidateCsv } from "./parsing";
import type { BulkParsingLabels } from "./parsing";

const labels = {
    pleaseRemoveChars: (chars: string) => `Please remove: ${chars}`,
    amountCannotBeEmpty: "Amount cannot be empty",
};

const parsingLabels: BulkParsingLabels = {
    rowPrefix: (row, message) => `Row ${row}: ${message}`,
    rowPrefixOnly: (row) => `Row ${row}: `,
    missingRecipientFirstColumn: "missing recipient",
    invalidNearAddress: (address) => `invalid near ${address}`,
    invalidChainAddress: (address, chain) =>
        `invalid ${chain} address ${address}`,
    rowNeedsAmountRecipient: "needs amount and recipient",
    missingRecipientBeforeComma: "missing recipient before comma",
    missingAmountAfterComma: (recipient) => `missing amount after ${recipient}`,
    invalidAmountNumber: (amountStr) => `invalid amount ${amountStr}`,
    amountGreaterThanZero: (amountStr) => `amount not > 0: ${amountStr}`,
    amountTooLarge: (amountStr) => `amount too large: ${amountStr}`,
    invalidAmountFallback: "invalid amount",
    pleaseRemoveChars: (chars) => `Please remove: ${chars}`,
    amountCannotBeEmpty: "Amount cannot be empty",
    tokenMismatch: (provided, expected) =>
        `token mismatch ${provided} vs ${expected}`,
    multipleTokenSymbols: (symbols) => `multiple symbols ${symbols}`,
    noPaymentDataFound: "no payment data",
    exceedsRecipientLimit: (count, limit) => `exceeds limit ${count}/${limit}`,
    noPaymentDataProvided: "no data provided",
    headerColumnsNotFound: "header not found",
    failedToParseCsv: "failed csv",
    failedToParsePaste: "failed paste",
    failedToValidateAccount: "failed validate account",
    nearValidationError: () => "near validation error",
    feeEstimationFailed: "fee failed",
    feeEstimationFailedRow: (row, recipient) =>
        `fee failed row ${row} ${recipient}`,
};

describe("parseAmount thousand separators", () => {
    it("parses a single 3-digit comma group as thousands, not decimal", () => {
        // Regression for #758: "1,000" must become 1000, not 1.0
        expect(parseAmount("1,000", labels).amount).toBe("1000");
        expect(parseAmount("2,500", labels).amount).toBe("2500");
    });

    it("keeps multi-group thousands separators working", () => {
        expect(parseAmount("1,000,000", labels).amount).toBe("1000000");
    });

    it("still treats a non-3-digit comma group as a decimal", () => {
        expect(parseAmount("10,5", labels).amount).toBe("10.5");
        expect(parseAmount("10,50", labels).amount).toBe("10.50");
        expect(parseAmount("1,2345", labels).amount).toBe("1.2345");
    });

    it("treats a 3-digit group after a leading zero as a decimal", () => {
        // "0,500" is only meaningful as 0.5, never as 500
        expect(parseAmount("0,500", labels).amount).toBe("0.500");
    });

    it("still handles mixed comma+dot formats", () => {
        expect(parseAmount("1,000.50", labels).amount).toBe("1000.50");
        expect(parseAmount("1.000,50", labels).amount).toBe("1000.50");
    });
});

describe("parseAndValidateCsv destination network", () => {
    const ethAddress = "0x1111111111111111111111111111111111111111";
    const nearAddress = "alice.near";
    const ethCsv = `recipient,amount\n${ethAddress},10`;
    const nearCsv = `recipient,amount\n${nearAddress},10`;

    it("validates addresses against receive network, not send token network", () => {
        // Source token lives on NEAR; receive network is eth.
        const result = parseAndValidateCsv(
            ethCsv,
            parsingLabels,
            { symbol: "USDC", network: "near", residency: "intents" },
            "eth",
        );

        expect(result.errors).toEqual([]);
        expect(result.payments).toHaveLength(1);
        expect(result.payments[0]?.recipient).toBe(ethAddress);
    });

    it("rejects near addresses when receive network is eth", () => {
        // Without destination override this would pass (token network = near).
        const result = parseAndValidateCsv(
            nearCsv,
            parsingLabels,
            { symbol: "USDC", network: "near", residency: "intents" },
            "eth",
        );

        expect(result.payments).toHaveLength(0);
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]?.message.toLowerCase()).toContain("eth");
    });

    it("requires nearcom: prefix for near.com destination", () => {
        const bare = parseAndValidateCsv(
            nearCsv,
            parsingLabels,
            { symbol: "USDC", network: "near", residency: "intents" },
            "near",
            "near.com",
        );
        expect(bare.payments).toHaveLength(0);
        expect(bare.errors.length).toBeGreaterThan(0);

        const prefixed = parseAndValidateCsv(
            `recipient,amount\nnearcom:alice.near,10`,
            parsingLabels,
            { symbol: "USDC", network: "near", residency: "intents" },
            "near",
            "near.com",
        );
        expect(prefixed.errors).toEqual([]);
        expect(prefixed.payments[0]?.recipient).toBe("nearcom:alice.near");
    });

    it("keeps nearcom: on NEAR when destination is not near.com (public)", () => {
        const result = parseAndValidateCsv(
            `recipient,amount\nnearcom:alice.near,10`,
            parsingLabels,
            { symbol: "USDC", network: "near", residency: "intents" },
            "near",
            "near",
        );
        expect(result.errors).toEqual([]);
        expect(result.payments).toHaveLength(1);
        expect(result.payments[0]?.recipient).toBe("nearcom:alice.near");
    });

    it("accepts nearcom: on public bulk with no destination network id", () => {
        const result = parseAndValidateCsv(
            `recipient,amount\nnearcom:megha19.near,10`,
            parsingLabels,
            { symbol: "NEAR", network: "near", residency: "Near" },
            "near",
        );
        expect(result.errors).toEqual([]);
        expect(result.payments[0]?.recipient).toBe("nearcom:megha19.near");
    });
});
