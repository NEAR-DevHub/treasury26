import { describe, expect, it } from "bun:test";
import {
    hasNearComAddressPrefix,
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
});
