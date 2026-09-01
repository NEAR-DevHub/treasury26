import { describe, expect, it } from "bun:test";
import { extractAddressFromQrPayload } from "./qr-address";

describe("extractAddressFromQrPayload", () => {
    it("returns a plain address untouched", () => {
        expect(extractAddressFromQrPayload("alice.near")).toBe("alice.near");
        expect(
            extractAddressFromQrPayload(
                "0x71C7656EC7ab88b098defB751B7401B5f6d8976F",
            ),
        ).toBe("0x71C7656EC7ab88b098defB751B7401B5f6d8976F");
    });

    it("strips wallet URI schemes and their trailing parameters", () => {
        expect(extractAddressFromQrPayload("ethereum:0xabc@1?value=1e18")).toBe(
            "0xabc",
        );
        expect(extractAddressFromQrPayload("near:alice.near")).toBe(
            "alice.near",
        );
        expect(extractAddressFromQrPayload("bitcoin:bc1qxy?amount=0.1")).toBe(
            "bc1qxy",
        );
        expect(extractAddressFromQrPayload("solana://sol1234")).toBe("sol1234");
    });

    it("leaves web links alone rather than inventing an address", () => {
        // The scheme match below would otherwise capture the host, and a
        // near.com send link keeps the recipient in a query param anyway.
        expect(
            extractAddressFromQrPayload(
                "https://near.com/send?recipient=nearcom%3Aalice.near",
            ),
        ).toBe("https://near.com/send?recipient=nearcom%3Aalice.near");
        expect(extractAddressFromQrPayload("https://near.com/alice.near")).toBe(
            "https://near.com/alice.near",
        );
        expect(extractAddressFromQrPayload("http://example.com/bob.near")).toBe(
            "http://example.com/bob.near",
        );
    });

    it("keeps the nearcom: prefix, which the near.com route requires", () => {
        expect(extractAddressFromQrPayload("nearcom:alice.near")).toBe(
            "nearcom:alice.near",
        );
    });

    it("collapses whitespace and handles empty payloads", () => {
        expect(extractAddressFromQrPayload("  alice.near \n")).toBe(
            "alice.near",
        );
        expect(extractAddressFromQrPayload("   ")).toBe("");
    });
});
