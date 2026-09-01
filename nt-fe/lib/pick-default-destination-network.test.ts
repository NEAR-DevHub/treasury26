import { describe, expect, it } from "bun:test";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import { pickDefaultDestinationNetwork } from "./pick-default-destination-network";

const nearCom = {
    id: NEAR_COM_NETWORK_ID,
    networkName: NEAR_NETWORK_ID,
};
const near = { id: NEAR_NETWORK_ID, networkName: NEAR_NETWORK_ID };
const eth = { id: "eth:1", networkName: "eth" };
const sol = { id: "sol:mainnet", networkName: "sol" };

describe("pickDefaultDestinationNetwork", () => {
    it("returns null for an empty list", () => {
        expect(pickDefaultDestinationNetwork([])).toBeNull();
    });

    it("picks the only chain option even when near.com is listed first", () => {
        expect(pickDefaultDestinationNetwork([nearCom, near])).toEqual(near);
    });

    it("picks the network with the highest USD holding", () => {
        expect(
            pickDefaultDestinationNetwork(
                [nearCom, eth, near, sol],
                [
                    { name: "eth", balanceUSD: 20 },
                    { name: "near", balanceUSD: 80 },
                    { name: "sol", balanceUSD: 5 },
                ],
            ),
        ).toEqual(near);
    });

    it("falls back to the first list item when nothing is held", () => {
        expect(pickDefaultDestinationNetwork([nearCom, eth, sol])).toEqual(
            nearCom,
        );
    });

    it("matches holdings by destination id as well as name", () => {
        expect(
            pickDefaultDestinationNetwork(
                [nearCom, eth, sol],
                [{ id: "sol:mainnet", balanceUSD: 12 }],
            ),
        ).toEqual(sol);
    });
});
