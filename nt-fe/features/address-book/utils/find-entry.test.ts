import { describe, expect, it } from "bun:test";
import {
    findAddressBookEntry,
    formatAddressBookDisplayAddress,
} from "./find-entry";

describe("findAddressBookEntry", () => {
    const entries = [
        { address: "alice.near", name: "Alice NEAR" },
        { address: "nearcom:alice.near", name: "Alice near.com" },
    ];

    it("matches the prefixed address only when the prefix is present", () => {
        expect(findAddressBookEntry(entries, "nearcom:alice.near")?.name).toBe(
            "Alice near.com",
        );
        expect(findAddressBookEntry(entries, "NEARCOM:Alice.near")?.name).toBe(
            "Alice near.com",
        );
    });

    it("does not match a bare account to a nearcom: entry", () => {
        expect(findAddressBookEntry(entries, "alice.near")?.name).toBe(
            "Alice NEAR",
        );
        expect(
            findAddressBookEntry(entries, "nearcom:bob.near"),
        ).toBeUndefined();
    });
});

describe("formatAddressBookDisplayAddress", () => {
    it("adds nearcom: for near.com contacts", () => {
        expect(
            formatAddressBookDisplayAddress({
                address: "megha19.near",
                networks: ["near.com"],
            }),
        ).toBe("nearcom:megha19.near");
        expect(
            formatAddressBookDisplayAddress({
                address: "nearcom:megha19.near",
                networks: ["near.com"],
            }),
        ).toBe("nearcom:megha19.near");
    });

    it("leaves bare NEAR contacts unprefixed", () => {
        expect(
            formatAddressBookDisplayAddress({
                address: "megha19.near",
                networks: ["near"],
            }),
        ).toBe("megha19.near");
    });
});
