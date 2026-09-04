import { describe, expect, it } from "bun:test";
import { isValidAddress } from "./address-validation";
import type { BlockchainType } from "./blockchain-utils";

/**
 * Every address below was run through 1click `POST /v0/quote` (dry) as the
 * recipient for that chain, so `accepted` records what the router itself does
 * rather than what a spec says. Rejecting something 1click takes hides a usable
 * network behind "invalid address"; accepting something it refuses trades that
 * for an opaque "recipient is not valid" at quote time.
 */
const VECTORS: Array<{
    chain: BlockchainType;
    address: string;
    accepted: boolean;
    note: string;
}> = [
    // Litecoin — bech32 is what Litecoin Core hands out by default.
    {
        chain: "litecoin",
        address: "ltc1q7w7zh3vjlc7fehzde6fe3ahen8ly72gep8ley2",
        accepted: true,
        note: "P2WPKH",
    },
    {
        chain: "litecoin",
        address:
            "ltc1qvcvn2p0qwtf70rtsmphpvf5alrtectw3vv6ehc8a0uadc3sefy2snzjuf0",
        accepted: true,
        note: "P2WSH",
    },
    {
        chain: "litecoin",
        address:
            "ltc1pluhst9fp50taa44kfdq5r5t27s8klsraeey3ct5y4vtremv3324spgjrhh",
        accepted: true,
        note: "taproot",
    },
    {
        chain: "litecoin",
        address: "LSubgbKZnfJHM9XWPV6g2neSAtvFdForYk",
        accepted: true,
        note: "legacy L",
    },
    {
        chain: "litecoin",
        address: "MAunSqn956RCq6WSZPAo7NuYxzenh13fNu",
        accepted: true,
        note: "P2SH M",
    },
    {
        chain: "litecoin",
        address: "3NC1NaztDgury8paCdpXwHgdSyR1cAxZUY",
        accepted: true,
        note: "deprecated P2SH 3",
    },
    {
        chain: "litecoin",
        address: "LTC1Q7W7ZH3VJLC7FEHZDE6FE3AHEN8LY72GEP8LEY2",
        accepted: false,
        note: "uppercase bech32",
    },

    // Bitcoin Cash — the CashAddr prefix is optional and often stripped on copy.
    {
        chain: "bitcoincash",
        address: "qzquh0rz9a4wtm0rf5ds0na4nh8pmcgeygr249pq6j",
        accepted: true,
        note: "bare CashAddr q",
    },
    {
        chain: "bitcoincash",
        address: "pr35vjq6l429s6p22vj3rtztktt88dfl6gmh0lkufv",
        accepted: true,
        note: "bare CashAddr p",
    },
    {
        chain: "bitcoincash",
        address: "bitcoincash:pr35vjq6l429s6p22vj3rtztktt88dfl6gmh0lkufv",
        accepted: true,
        note: "prefixed CashAddr",
    },
    {
        chain: "bitcoincash",
        address: "1HRanBK2VVQDbLEQRKLFUqQLRAM3KucGQ5",
        accepted: true,
        note: "legacy",
    },

    // Dash — P2SH renders with a leading 7.
    {
        chain: "dash",
        address: "XgNfwQkSTGHwvfNfDrukHSmNjLw29zxYby",
        accepted: true,
        note: "P2PKH X",
    },
    {
        chain: "dash",
        address: "7hL3U2dJGP1FzcdjAMTeZ7XSPKbb2bU8sN",
        accepted: true,
        note: "P2SH 7",
    },

    // Dogecoin — 1click takes the A rendering of P2SH but not the 9 one.
    {
        chain: "dogecoin",
        address: "DRUrXtvAk4f4GMwfWKTbfCrpDFxtV81VaK",
        accepted: true,
        note: "P2PKH D",
    },
    {
        chain: "dogecoin",
        address: "A8PpeLnTTpHXekMQP1vqFMvEd5xEujysoE",
        accepted: true,
        note: "P2SH A",
    },
    {
        chain: "dogecoin",
        address: "9ypB6p7sNV5q3qdYsgYcLxM1BHyHCPk995",
        accepted: false,
        note: "P2SH 9",
    },

    // TON — friendly base64url plus the raw workchain form.
    {
        chain: "ton",
        address: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
        accepted: true,
        note: "EQ bounceable",
    },
    {
        chain: "ton",
        address: "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI",
        accepted: true,
        note: "UQ non-bounceable",
    },
    {
        chain: "ton",
        address:
            "0:83dfd552e6372da472fcbcc8c45ebcc669170255862da1d751f27a7003a0f31a",
        accepted: true,
        note: "raw workchain 0",
    },
    {
        chain: "ton",
        address:
            "-1:83dfd552e6372da472fcbcc8c45ebcc669170255862da1d751f27a7003a0f31a",
        accepted: true,
        note: "raw masterchain",
    },

    // Aptos / Sui — both want the padded 32-byte form.
    {
        chain: "aptos",
        address:
            "0x0b9d5a2f04d2b0d8d8e42f2b7f4f0e0b06b2c9b7e2c9c0f1a2b3c4d5e6f70819",
        accepted: true,
        note: "64 hex",
    },
    {
        chain: "aptos",
        address:
            "0xb9d5a2f04d2b0d8d8e42f2b7f4f0e0b06b2c9b7e2c9c0f1a2b3c4d5e6f70819",
        accepted: false,
        note: "zero-trimmed 63 hex",
    },
    { chain: "aptos", address: "0x1", accepted: false, note: "short form" },
    {
        chain: "sui",
        address:
            "0x02a212de6a9dfa3a69e22387acfbafbb1a9e591bd9d636e7895dcfc8de05f331",
        accepted: true,
        note: "64 hex",
    },
    { chain: "sui", address: "0x2", accepted: false, note: "short form" },

    // Cardano — payment addresses only.
    {
        chain: "cardano",
        address:
            "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
        accepted: true,
        note: "Shelley addr1",
    },
    {
        chain: "cardano",
        address: "stake1uyehkck0lajq8gr28t9uxnuvgcqrc6070x3k9r8048z8y5gh6ffgw",
        accepted: false,
        note: "stake1 reward address",
    },

    // Bitcoin — unchanged, guarding against regressions in the shared charset.
    {
        chain: "bitcoin",
        address: "1Exk67Lps24CK264gFhfWsA3fkTXADHMBf",
        accepted: true,
        note: "P2PKH",
    },
    {
        chain: "bitcoin",
        address: "39uRSBbwjxdSrJDE6Ge7T6wRRQmt1iHbhM",
        accepted: true,
        note: "P2SH",
    },
    {
        chain: "bitcoin",
        address: "bc1qxm4hqwahycepeqcm0ypavy29glpfugdncxvd0y",
        accepted: true,
        note: "P2WPKH",
    },
    {
        chain: "bitcoin",
        address:
            "bc1p8vfcm6xdnjdax4k34mgx7tan46h7j7jc4qactpvud3m5u725wwjq4uaa67",
        accepted: true,
        note: "taproot",
    },

    // Chains left alone, pinned so the shared edits do not disturb them.
    {
        chain: "stellar",
        address: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
        accepted: true,
        note: "G account",
    },
    {
        chain: "xrp",
        address: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv",
        accepted: true,
        note: "r classic",
    },
    {
        chain: "tron",
        address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        accepted: true,
        note: "T address",
    },
    {
        chain: "solana",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        accepted: true,
        note: "base58",
    },
    {
        chain: "ethereum",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        accepted: true,
        note: "checksummed",
    },
    {
        chain: "zcash",
        address: "t1KsBQpAhFqiwpUAEXPn8v1PFXf2Ph6dJhP",
        accepted: true,
        note: "t1 transparent",
    },
    {
        chain: "zcash",
        address: "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd",
        accepted: true,
        note: "t3 P2SH",
    },
];

describe("isValidAddress agrees with 1click", () => {
    for (const { chain, address, accepted, note } of VECTORS) {
        it(`${accepted ? "accepts" : "rejects"} ${chain} ${note}`, () => {
            expect(isValidAddress(address, chain)).toBe(accepted);
        });
    }
});

describe("isValidAddress rejects addresses from the wrong chain", () => {
    it("does not take a Litecoin bech32 address for Bitcoin", () => {
        expect(
            isValidAddress(
                "ltc1q7w7zh3vjlc7fehzde6fe3ahen8ly72gep8ley2",
                "bitcoin",
            ),
        ).toBe(false);
    });

    it("does not take a Bitcoin bech32 address for Litecoin", () => {
        expect(
            isValidAddress(
                "bc1qxm4hqwahycepeqcm0ypavy29glpfugdncxvd0y",
                "litecoin",
            ),
        ).toBe(false);
    });

    it("does not take a Dash P2SH address for Dogecoin", () => {
        expect(
            isValidAddress("7hL3U2dJGP1FzcdjAMTeZ7XSPKbb2bU8sN", "dogecoin"),
        ).toBe(false);
    });

    it("does not take a TON raw address for Sui", () => {
        expect(
            isValidAddress(
                "0:83dfd552e6372da472fcbcc8c45ebcc669170255862da1d751f27a7003a0f31a",
                "sui",
            ),
        ).toBe(false);
    });
});
