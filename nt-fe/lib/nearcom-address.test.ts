import { describe, expect, it } from "bun:test";
import {
    buildNearComSendHref,
    NEAR_COM_SEND_URL,
    withNearComAddressPrefix,
} from "./nearcom-address";

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
