import { describe, expect, it } from "bun:test";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import { getCompatibleChains } from "./compatible-chains";
import type { ChainInfo } from "./chains";

const chains: ChainInfo[] = [
    { key: NEAR_NETWORK_ID, name: "NEAR", icon: "/near.svg" },
    { key: NEAR_COM_NETWORK_ID, name: "near.com", icon: "/near.com.svg" },
    { key: "eth", name: "Ethereum", icon: "/eth.svg" },
];

describe("getCompatibleChains", () => {
    it("shows only near.com for nearcom: plus a valid NEAR account", () => {
        expect(
            getCompatibleChains("nearcom:alice.near", chains).map((c) => c.key),
        ).toEqual([NEAR_COM_NETWORK_ID]);
    });

    it("hides near.com when the prefix is missing or the account is invalid", () => {
        expect(
            getCompatibleChains("alice.near", chains).map((c) => c.key),
        ).toEqual([NEAR_NETWORK_ID]);
        expect(getCompatibleChains("nearcom:", chains)).toEqual([]);
        expect(getCompatibleChains("nearcom:not valid", chains)).toEqual([]);
    });
});
