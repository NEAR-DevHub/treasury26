import { describe, expect, it } from "bun:test";
import {
    buildPaySharePath,
    buildPayWithTrezuPaymentsPath,
    hasChoosePayerParam,
    parsePayShareKind,
    withChoosePayerParam,
    withoutChoosePayerParam,
} from "./deposit-transfer-url";

describe("buildPaySharePath", () => {
    it("builds confidential one-time share with id only", () => {
        const path = buildPaySharePath("dao.sputnik-dao.near", {
            kind: "public",
            id: "0xquote",
        });

        expect(path).toBe("/dao.sputnik-dao.near/pay/public?id=0xquote");
    });

    it("includes token and network for public treasury shares", () => {
        const path = buildPaySharePath("dao.sputnik-dao.near", {
            kind: "public",
            id: "0xbridge",
            token: "usdc",
            network:
                "nep141:eth-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.omft.near",
        });

        const params = new URLSearchParams(path.split("?")[1]);
        expect(path.startsWith("/dao.sputnik-dao.near/pay/public?")).toBe(true);
        expect(params.get("id")).toBe("0xbridge");
        expect(params.get("token")).toBe("usdc");
        expect(params.get("network")).toContain("nep141:");
        expect(params.get("expiresAt")).toBeNull();
        expect(params.get("quote")).toBeNull();
        expect(params.get("address")).toBeNull();
    });

    it("builds a confidential reusable share with source only", () => {
        const path = buildPaySharePath("dao.sputnik-dao.near", {
            kind: "confidential",
            source: "trezu",
        });

        expect(path).toBe(
            "/dao.sputnik-dao.near/pay/confidential?source=trezu",
        );
    });
});

describe("parsePayShareKind", () => {
    it("accepts public and confidential", () => {
        expect(parsePayShareKind("public")).toBe("public");
        expect(parsePayShareKind("confidential")).toBe("confidential");
        expect(parsePayShareKind("other")).toBeNull();
        expect(parsePayShareKind(null)).toBeNull();
    });
});

describe("withChoosePayerParam", () => {
    it("adds choosePayer=1 for post-login resume", () => {
        expect(
            withChoosePayerParam(
                "/dao.sputnik-dao.near/pay/confidential?source=trezu",
            ),
        ).toBe(
            "/dao.sputnik-dao.near/pay/confidential?source=trezu&choosePayer=1",
        );
    });
});

describe("withoutChoosePayerParam", () => {
    it("strips choosePayer so shared links stay inert", () => {
        expect(
            withoutChoosePayerParam(
                "/dao.sputnik-dao.near/pay/confidential?source=trezu&choosePayer=1",
            ),
        ).toBe("/dao.sputnik-dao.near/pay/confidential?source=trezu");
    });
});

describe("hasChoosePayerParam", () => {
    it("detects choosePayer via URL parsing", () => {
        expect(
            hasChoosePayerParam(
                "/dao.sputnik-dao.near/pay/public?choosePayer=1",
            ),
        ).toBe(true);
        expect(
            hasChoosePayerParam("/dao.sputnik-dao.near/pay/confidential"),
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
