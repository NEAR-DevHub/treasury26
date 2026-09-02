import { describe, expect, it } from "bun:test";
import {
    formatRecipientForNearComDestination,
    hasNearComAddressPrefix,
    isNearComRecipientAddress,
    parseNearComAddress,
    stripNearComAddressPrefix,
    withNearComAddressPrefix,
} from "./nearcom-address";

describe("nearcom-address", () => {
    it("detects and strips prefix", () => {
        expect(hasNearComAddressPrefix("nearcom:alice.near")).toBe(true);
        expect(hasNearComAddressPrefix("NEARCOM:alice.near")).toBe(true);
        expect(hasNearComAddressPrefix("alice.near")).toBe(false);
        expect(stripNearComAddressPrefix("nearcom:alice.near")).toBe(
            "alice.near",
        );
        expect(stripNearComAddressPrefix("alice.near")).toBe("alice.near");
    });

    it("adds prefix without doubling", () => {
        expect(withNearComAddressPrefix("alice.near")).toBe(
            "nearcom:alice.near",
        );
        expect(withNearComAddressPrefix("nearcom:alice.near")).toBe(
            "nearcom:alice.near",
        );
    });

    it("requires prefix plus a valid NEAR account", () => {
        expect(isNearComRecipientAddress("nearcom:alice.near")).toBe(true);
        expect(isNearComRecipientAddress("NEARCOM:alice.near")).toBe(true);
        expect(isNearComRecipientAddress("alice.near")).toBe(false);
        expect(isNearComRecipientAddress("nearcom:")).toBe(false);
        expect(isNearComRecipientAddress("nearcom:not valid")).toBe(false);
    });

    it("parses prefix + account", () => {
        expect(parseNearComAddress("nearcom:dao.sputnik-dao.near")).toEqual({
            hasPrefix: true,
            accountId: "dao.sputnik-dao.near",
        });
        expect(parseNearComAddress("dao.sputnik-dao.near")).toEqual({
            hasPrefix: false,
            accountId: "dao.sputnik-dao.near",
        });
    });

    it("formats display address only for near.com destination", () => {
        expect(
            formatRecipientForNearComDestination("alice.near", "near.com"),
        ).toBe("nearcom:alice.near");
        expect(
            formatRecipientForNearComDestination(
                "nearcom:alice.near",
                "near.com",
            ),
        ).toBe("nearcom:alice.near");
        expect(formatRecipientForNearComDestination("alice.near", "near")).toBe(
            "alice.near",
        );
        expect(
            formatRecipientForNearComDestination(
                "alice.near",
                "near.com:direct",
            ),
        ).toBe("alice.near");
        expect(formatRecipientForNearComDestination("alice.near", "eth")).toBe(
            "alice.near",
        );
        expect(
            formatRecipientForNearComDestination("alice.near", undefined),
        ).toBe("alice.near");
    });
});
