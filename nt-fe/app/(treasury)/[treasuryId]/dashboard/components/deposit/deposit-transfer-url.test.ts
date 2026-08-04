import { describe, expect, it } from "bun:test";
import {
    buildDepositTransferPath,
    buildPayWithTrezuPaymentsPath,
    hasChoosePayerParam,
    parseTransferType,
    withChoosePayerParam,
    withoutChoosePayerParam,
} from "./deposit-transfer-url";

describe("buildDepositTransferPath", () => {
    it("builds a public transfer URL with only address, token, and network", () => {
        const path = buildDepositTransferPath("dao.sputnik-dao.near", {
            type: "public",
            address: "0xabc123",
            token: "usdc",
            network:
                "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        });

        expect(path.startsWith("/dao.sputnik-dao.near/deposit/transfer?")).toBe(
            true,
        );
        const params = new URLSearchParams(path.split("?")[1]);
        expect(params.get("type")).toBe("public");
        expect(params.get("address")).toBe("0xabc123");
        expect(params.get("token")).toBe("usdc");
        expect(params.get("network")).toContain("nep141:");
        expect(params.get("symbol")).toBeNull();
        expect(params.get("min")).toBeNull();
        expect(params.get("expiresAt")).toBeNull();
        expect(params.get("treasuryName")).toBeNull();
    });

    it("builds a confidential transfer URL with source only", () => {
        const path = buildDepositTransferPath("dao.sputnik-dao.near", {
            type: "confidential",
            source: "trezu",
        });

        const params = new URLSearchParams(path.split("?")[1]);
        expect(params.get("type")).toBe("confidential");
        expect(params.get("source")).toBe("trezu");
        expect(params.get("address")).toBeNull();
        expect(params.get("token")).toBeNull();
    });
});

describe("parseTransferType", () => {
    it("maps public and legacy one-time to public", () => {
        expect(parseTransferType("public")).toBe("public");
        expect(parseTransferType("one-time")).toBe("public");
    });

    it("infers public from address/token params when type is missing", () => {
        expect(parseTransferType(null, { hasPublicParams: true })).toBe(
            "public",
        );
    });

    it("defaults unknown values to confidential", () => {
        expect(parseTransferType("confidential")).toBe("confidential");
        expect(parseTransferType(null)).toBe("confidential");
    });
});

describe("withChoosePayerParam", () => {
    it("adds choosePayer=1 for post-login resume", () => {
        expect(
            withChoosePayerParam(
                "/dao.sputnik-dao.near/deposit/transfer?type=confidential",
            ),
        ).toBe(
            "/dao.sputnik-dao.near/deposit/transfer?type=confidential&choosePayer=1",
        );
    });
});

describe("withoutChoosePayerParam", () => {
    it("strips choosePayer so shared links stay inert", () => {
        expect(
            withoutChoosePayerParam(
                "/dao.sputnik-dao.near/deposit/transfer?type=confidential&choosePayer=1&source=trezu",
            ),
        ).toBe(
            "/dao.sputnik-dao.near/deposit/transfer?type=confidential&source=trezu",
        );
    });
});

describe("hasChoosePayerParam", () => {
    it("detects choosePayer via URL parsing", () => {
        expect(
            hasChoosePayerParam(
                "/dao.sputnik-dao.near/deposit/transfer?choosePayer=1",
            ),
        ).toBe(true);
        expect(
            hasChoosePayerParam(
                "/dao.sputnik-dao.near/deposit/transfer?type=confidential",
            ),
        ).toBe(false);
    });
});

describe("buildPayWithTrezuPaymentsPath", () => {
    it("builds payments deep link with address and networks", () => {
        const path = buildPayWithTrezuPaymentsPath("payer.sputnik-dao.near", {
            address: "dest.sputnik-dao.near",
            networks: "near.com",
        });
        expect(path).toBe(
            "/payer.sputnik-dao.near/payments?address=dest.sputnik-dao.near&networks=near.com",
        );
    });
});
