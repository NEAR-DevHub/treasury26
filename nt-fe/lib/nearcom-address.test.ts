import { describe, expect, it } from "bun:test";
import {
    buildNearComSendHref,
    formatRecipientForNearComDestination,
    hasNearComAddressPrefix,
    NEAR_COM_SEND_URL,
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

describe("buildNearComSendHref", () => {
    it("builds a send URL with token, paymentToken, network, and recipient", () => {
        expect(
            buildNearComSendHref({
                token: "USDC",
                paymentToken: "USDC",
                network: "eth",
                recipient: "0xD7A7486Dba405cBd55FA685Dce53E6E2B755485B",
            }),
        ).toBe(
            `${NEAR_COM_SEND_URL}?token=USDC&network=eth&recipient=0xD7A7486Dba405cBd55FA685Dce53E6E2B755485B&paymentToken=USDC`,
        );
    });

    it("omits empty params", () => {
        expect(
            buildNearComSendHref({
                recipient: withNearComAddressPrefix("dao.near"),
                network: "near_intents",
                token: "  ",
            }),
        ).toBe(
            `${NEAR_COM_SEND_URL}?network=near_intents&recipient=nearcom%3Adao.near`,
        );
    });

    it("matches the confidential near.com internal send format", () => {
        expect(
            buildNearComSendHref({
                network: "near_intents",
                recipient: withNearComAddressPrefix("alice.near"),
            }),
        ).toBe(
            `${NEAR_COM_SEND_URL}?network=near_intents&recipient=nearcom%3Aalice.near`,
        );
    });

    it("returns the bare send URL when nothing is prefilled", () => {
        expect(buildNearComSendHref({})).toBe(NEAR_COM_SEND_URL);
    });
});
