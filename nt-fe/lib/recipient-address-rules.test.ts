import { describe, expect, it } from "bun:test";
import {
    canAddressUseDestination,
    checkRecipientAddressFormat,
    inferRecipientBlockchain,
    isRecognizedRecipientAddress,
    nearComPrefixIssue,
    resolveRecipientBlockchain,
} from "./recipient-address-rules";

const EVM = "0x71C7656EC7ab88b098defB751B7401B5f6d8976F";

describe("resolveRecipientBlockchain", () => {
    it("maps near.com destination ids onto NEAR", () => {
        expect(resolveRecipientBlockchain("near.com")).toBe("near");
        expect(resolveRecipientBlockchain("near.com:direct")).toBe("near");
    });

    it("still resolves ordinary chains", () => {
        expect(resolveRecipientBlockchain("near")).toBe("near");
        expect(resolveRecipientBlockchain("eth")).toBe("ethereum");
        expect(resolveRecipientBlockchain(null)).toBe("unknown");
    });
});

describe("nearComPrefixIssue", () => {
    it("requires the prefix for a near.com destination", () => {
        expect(
            nearComPrefixIssue({
                address: "someone.near",
                isNearComDestination: true,
            }),
        ).toBe("nearComPrefixRequired");
        expect(
            nearComPrefixIssue({
                address: "nearcom:someone.near",
                isNearComDestination: true,
            }),
        ).toBeNull();
    });

    it("rejects the prefix everywhere else", () => {
        expect(
            nearComPrefixIssue({
                address: "nearcom:someone.near",
                isNearComDestination: false,
            }),
        ).toBe("nearComPrefixNotAllowed");
        expect(
            nearComPrefixIssue({
                address: "someone.near",
                isNearComDestination: false,
            }),
        ).toBeNull();
    });
});

describe("checkRecipientAddressFormat", () => {
    it("accepts a prefixed account for near.com", () => {
        expect(
            checkRecipientAddressFormat({
                address: "nearcom:someone.near",
                network: "near.com",
            }),
        ).toBeNull();
    });

    it("rejects a prefixed account for bare NEAR", () => {
        // The bug this module exists to prevent: previously accepted here and
        // then cleared by the network picker.
        expect(
            checkRecipientAddressFormat({
                address: "nearcom:someone.near",
                network: "near",
            }),
        ).toBe("nearComPrefixNotAllowed");
    });

    it("accepts a bare account for NEAR and rejects it for near.com", () => {
        expect(
            checkRecipientAddressFormat({
                address: "someone.near",
                network: "near",
            }),
        ).toBeNull();
        expect(
            checkRecipientAddressFormat({
                address: "someone.near",
                network: "near.com",
            }),
        ).toBe("nearComPrefixRequired");
    });

    it("reports a malformed near.com account separately from the prefix", () => {
        expect(
            checkRecipientAddressFormat({
                address: "nearcom:not a near account",
                network: "near.com",
            }),
        ).toBe("invalidFormat");
    });

    it("checks the chain format for other networks", () => {
        expect(
            checkRecipientAddressFormat({ address: EVM, network: "eth" }),
        ).toBeNull();
        expect(
            checkRecipientAddressFormat({
                address: "someone.near",
                network: "eth",
            }),
        ).toBe("invalidFormat");
    });

    it("reports an unpicked destination distinctly from a bad address", () => {
        expect(
            checkRecipientAddressFormat({ address: EVM, network: null }),
        ).toBe("unknownDestination");
    });

    it("withholds judgement on the prefix until a destination exists", () => {
        // Recipient is entered before the network, so "no destination" must
        // not be read as "not near.com" and reject the prefix outright.
        expect(
            checkRecipientAddressFormat({
                address: "nearcom:someone.near",
                network: null,
            }),
        ).toBe("unknownDestination");
    });

    it("honours an explicit near.com override from the network picker", () => {
        // The picker knows the route from the option id, while networkName
        // stays the underlying chain.
        expect(
            checkRecipientAddressFormat({
                address: "nearcom:someone.near",
                network: "near",
                isNearComDestination: true,
            }),
        ).toBeNull();
    });
});

describe("canAddressUseDestination", () => {
    it("keeps near.com selectable while the account is still being typed", () => {
        expect(
            canAddressUseDestination({
                address: "nearcom:so",
                network: "near",
                isNearComDestination: true,
            }),
        ).toBe(true);
        // The strict check still flags the incomplete account.
        expect(
            checkRecipientAddressFormat({
                address: "nearcom:so",
                network: "near",
                isNearComDestination: true,
            }),
        ).toBe("invalidFormat");
    });

    it("routes a prefixed address to near.com only", () => {
        expect(
            canAddressUseDestination({
                address: "nearcom:someone.near",
                network: "near",
            }),
        ).toBe(false);
        expect(canAddressUseDestination({ address: EVM, network: "eth" })).toBe(
            true,
        );
    });

    it("treats an empty address as compatible with anything", () => {
        expect(canAddressUseDestination({ address: "", network: "eth" })).toBe(
            true,
        );
    });
});

describe("inferRecipientBlockchain", () => {
    it("reads the chain off the address, ignoring any destination", () => {
        expect(inferRecipientBlockchain("someone.near")).toBe("near");
        expect(
            inferRecipientBlockchain(
                "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            ),
        ).toBe("bitcoin");
        expect(
            inferRecipientBlockchain(
                "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
            ),
        ).toBe("solana");
    });

    it("resolves an 0x address to NEAR, which accepts it as implicit", () => {
        // Both chains accept the format. NEAR validates eth-implicit accounts
        // without an existence check, so the address is never falsely
        // rejected, and every EVM destination stays selectable.
        expect(inferRecipientBlockchain(EVM)).toBe("near");
    });

    it("treats nearcom: as NEAR only with a valid account", () => {
        expect(inferRecipientBlockchain("nearcom:someone.near")).toBe("near");
        expect(inferRecipientBlockchain("nearcom:")).toBeNull();
        expect(inferRecipientBlockchain("nearcom:not valid")).toBeNull();
    });

    it("returns null for text that is not an address", () => {
        expect(inferRecipientBlockchain("")).toBeNull();
        expect(inferRecipientBlockchain("Alice")).toBeNull();
    });
});

describe("isRecognizedRecipientAddress", () => {
    it("rejects empty strings and contact-name text", () => {
        expect(isRecognizedRecipientAddress("")).toBe(false);
        expect(isRecognizedRecipientAddress("Alice")).toBe(false);
        expect(isRecognizedRecipientAddress("alice")).toBe(false);
    });

    it("accepts NEAR named accounts and near.com recipients", () => {
        expect(isRecognizedRecipientAddress("someone.near")).toBe(true);
        expect(isRecognizedRecipientAddress("nearcom:someone.near")).toBe(true);
        expect(isRecognizedRecipientAddress("nearcom:")).toBe(false);
        expect(isRecognizedRecipientAddress("nearcom:not valid")).toBe(false);
    });

    it("accepts known non-NEAR chain formats", () => {
        expect(isRecognizedRecipientAddress(EVM)).toBe(true);
        expect(
            isRecognizedRecipientAddress(
                "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
            ),
        ).toBe(true);
    });
});
