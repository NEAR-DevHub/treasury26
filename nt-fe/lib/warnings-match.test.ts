import { describe, expect, it } from "bun:test";
import type { Warning } from "@/hooks/use-warnings";
import { warningMatchesQuery } from "@/hooks/use-warnings";
import { networksMatchForWarningScope } from "@/components/token-display";

function scopedWarning(
    overrides: Partial<Warning> & Pick<Warning, "token" | "network">,
): Warning {
    return {
        id: 1,
        slot: "deposit",
        response: "paused",
        severity: "high",
        situation: "network_paused",
        message: null,
        showFrom: null,
        startsAt: null,
        endsAt: null,
        ...overrides,
    };
}

describe("networksMatchForWarningScope", () => {
    it("matches exact names case-insensitively", () => {
        expect(networksMatchForWarningScope("eth", "ETH")).toBe(true);
        expect(networksMatchForWarningScope("arbitrum", "Arbitrum")).toBe(true);
    });

    it("matches short and long aliases that share a display name", () => {
        expect(networksMatchForWarningScope("arb", "arbitrum")).toBe(true);
        expect(networksMatchForWarningScope("eth", "ethereum")).toBe(true);
        expect(networksMatchForWarningScope("sol", "solana")).toBe(true);
        expect(networksMatchForWarningScope("pol", "polygon")).toBe(true);
    });

    it("does not match unrelated chains", () => {
        expect(networksMatchForWarningScope("arb", "eth")).toBe(false);
        expect(networksMatchForWarningScope("base", "arbitrum")).toBe(false);
        expect(networksMatchForWarningScope("ethereum", "arbitrum")).toBe(
            false,
        );
    });

    it("rejects missing values", () => {
        expect(networksMatchForWarningScope("arb", null)).toBe(false);
        expect(networksMatchForWarningScope(undefined, "arbitrum")).toBe(false);
    });
});

describe("warningMatchesQuery scope AND semantics", () => {
    it("matches same token + arb/arbitrum alias on deposit", () => {
        const warning = scopedWarning({ token: "usdc", network: "arbitrum" });
        expect(warningMatchesQuery(warning, "deposit", "usdc", "arb")).toBe(
            true,
        );
        expect(
            warningMatchesQuery(warning, "deposit", "usdc", "arbitrum"),
        ).toBe(true);
    });

    it("rejects wrong token even when network aliases match", () => {
        const warning = scopedWarning({ token: "eth", network: "arbitrum" });
        expect(warningMatchesQuery(warning, "deposit", "usdc", "arb")).toBe(
            false,
        );
        expect(warningMatchesQuery(warning, "deposit", "weth", "arb")).toBe(
            false,
        );
    });

    it("rejects wrong network even when token matches", () => {
        const warning = scopedWarning({ token: "usdc", network: "arbitrum" });
        expect(warningMatchesQuery(warning, "deposit", "usdc", "eth")).toBe(
            false,
        );
        expect(warningMatchesQuery(warning, "deposit", "usdc", "base")).toBe(
            false,
        );
        expect(
            warningMatchesQuery(warning, "deposit", "usdc", "ethereum"),
        ).toBe(false);
    });

    it("rejects eth-on-eth warning when selecting eth-on-arb", () => {
        const warning = scopedWarning({ token: "eth", network: "eth" });
        expect(warningMatchesQuery(warning, "deposit", "eth", "arb")).toBe(
            false,
        );
        expect(warningMatchesQuery(warning, "deposit", "eth", "arbitrum")).toBe(
            false,
        );
        expect(warningMatchesQuery(warning, "deposit", "eth", "eth")).toBe(
            true,
        );
        expect(warningMatchesQuery(warning, "deposit", "eth", "ethereum")).toBe(
            true,
        );
    });

    it("rejects when query omits network but warning is network-scoped", () => {
        const warning = scopedWarning({ token: "usdc", network: "arbitrum" });
        expect(warningMatchesQuery(warning, "deposit", "usdc")).toBe(false);
        expect(warningMatchesQuery(warning, "deposit", "usdc", undefined)).toBe(
            false,
        );
    });

    it("rejects wrong slot even with matching token/network", () => {
        const warning = scopedWarning({ token: "usdc", network: "arbitrum" });
        expect(warningMatchesQuery(warning, "payment", "usdc", "arb")).toBe(
            false,
        );
    });

    it("token-only warning matches any network for that token", () => {
        const warning = scopedWarning({ token: "usdc", network: null });
        expect(warningMatchesQuery(warning, "deposit", "usdc", "arb")).toBe(
            true,
        );
        expect(warningMatchesQuery(warning, "deposit", "usdc", "eth")).toBe(
            true,
        );
        expect(warningMatchesQuery(warning, "deposit", "eth", "arb")).toBe(
            false,
        );
    });

    it("network-only warning matches any token on that chain (incl. alias)", () => {
        const warning = scopedWarning({ token: null, network: "arbitrum" });
        expect(warningMatchesQuery(warning, "deposit", "usdc", "arb")).toBe(
            true,
        );
        expect(warningMatchesQuery(warning, "deposit", "eth", "arb")).toBe(
            true,
        );
        expect(warningMatchesQuery(warning, "deposit", "usdc", "eth")).toBe(
            false,
        );
    });
});
