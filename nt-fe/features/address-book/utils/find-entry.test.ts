import { describe, expect, it } from "bun:test";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import {
    addressBookEntryMatchesNetwork,
    findAddressBookEntry,
    formatAddressBookDisplayAddress,
    persistAddressBookAddress,
} from "./find-entry";

describe("findAddressBookEntry", () => {
    const entries = [
        { address: "alice.near", name: "Alice NEAR", networks: ["near"] },
        {
            address: "nearcom:alice.near",
            name: "Alice near.com",
            networks: ["near.com"],
        },
    ];

    it("matches a prefixed recipient only to a near.com contact", () => {
        expect(findAddressBookEntry(entries, "nearcom:alice.near")?.name).toBe(
            "Alice near.com",
        );
        expect(findAddressBookEntry(entries, "NEARCOM:Alice.near")?.name).toBe(
            "Alice near.com",
        );
    });

    it("matches a near.com contact stored without the prefix", () => {
        const storedBare = [
            {
                address: "alice.near",
                name: "Alice near.com",
                networks: ["near.com"],
            },
        ];
        expect(
            findAddressBookEntry(storedBare, "nearcom:alice.near")?.name,
        ).toBe("Alice near.com");
        expect(findAddressBookEntry(storedBare, "alice.near")).toBeUndefined();
    });

    it("does not attach a NEAR contact name to a nearcom: recipient", () => {
        const nearOnly = [
            { address: "alice.near", name: "Alice NEAR", networks: ["near"] },
        ];
        expect(
            findAddressBookEntry(nearOnly, "nearcom:alice.near"),
        ).toBeUndefined();
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

describe("persistAddressBookAddress", () => {
    it("writes nearcom: when the contact is on near.com", () => {
        expect(
            persistAddressBookAddress({
                address: "alice.near",
                networks: ["near.com"],
            }),
        ).toBe("nearcom:alice.near");
    });
});

describe("addressBookEntryMatchesNetwork", () => {
    it("keeps near.com contacts on the near.com destination only", () => {
        const nearCom = {
            address: "nearcom:alice.near",
            networks: [NEAR_COM_NETWORK_ID],
        };
        expect(
            addressBookEntryMatchesNetwork(
                nearCom,
                NEAR_COM_NETWORK_ID,
                NEAR_NETWORK_ID,
            ),
        ).toBe(true);
        expect(
            addressBookEntryMatchesNetwork(nearCom, NEAR_NETWORK_ID, "near"),
        ).toBe(false);
    });
});
