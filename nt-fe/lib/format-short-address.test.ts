import { describe, expect, it } from "bun:test";
import { formatShortAddress } from "./format-short-address";

describe("formatShortAddress", () => {
    it("keeps short addresses intact", () => {
        expect(formatShortAddress("alice.near")).toBe("alice.near");
        expect(formatShortAddress("0x1234567890")).toBe("0x1234567890");
    });

    it("uses start then ellipsis then end for long addresses", () => {
        expect(
            formatShortAddress("0x71C7656EC7ab88b098defB751B7401B5f6d8976F"),
        ).toBe("0x71C7...d8976F");
        expect(
            formatShortAddress("7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV"),
        ).toBe("7EcDhS...wCFLtV");
    });

    it("uses the same 6/6 window as the recipient modal", () => {
        const address = "abcdefghijklmnopqrstuvwxyz";
        expect(formatShortAddress(address)).toBe("abcdef...uvwxyz");
        expect(formatShortAddress(address).startsWith("abcdef")).toBe(true);
        expect(formatShortAddress(address).endsWith("uvwxyz")).toBe(true);
        expect(formatShortAddress(address)).toContain("...");
    });
});
