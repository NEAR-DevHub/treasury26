import { checkRecipientAddressFormat } from "@/lib/recipient-address-rules";

type Sample = {
    network: string;
    address: string;
    note: string;
};

const samples: Sample[] = [
    // ── Bitcoin ──────────────────────────────────────────────────────────
    {
        network: "btc",
        address: "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
        note: "P2PKH — genesis block coinbase",
    },
    {
        network: "btc",
        address: "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
        note: "P2SH",
    },
    {
        network: "btc",
        address: "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
        note: "P2WPKH — BIP173 vector",
    },
    {
        network: "btc",
        address:
            "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
        note: "P2WSH — BIP173 vector",
    },
    {
        network: "btc",
        address:
            "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
        note: "P2TR taproot — BIP350 vector",
    },
    {
        network: "btc",
        address: "bc1pmzfrwwndsqmk5yh69yjr5lfgfg4ev8c0tsc06e",
        note: "P2TR short form",
    },

    // ── Litecoin ─────────────────────────────────────────────────────────
    {
        network: "ltc",
        address: "LM2WMpR1Rp6j3Sa59cMXMs1SPzj9eXpGc1",
        note: "P2PKH legacy L",
    },
    {
        network: "ltc",
        address: "MQMcJhpWHYVeQArcZR3sBgyPZxxRtnH441",
        note: "P2SH M",
    },
    {
        network: "ltc",
        address: "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kn40wv3",
        note: "native segwit ltc1 — default in Litecoin Core",
    },
    {
        network: "ltc",
        address:
            "ltc1qd5wm03t5kcdupjuyq5jffpuacnaqahvfsdu8smf8z0u0pqdqpatqsdrmv3",
        note: "P2WSH ltc1",
    },

    // ── Bitcoin Cash ─────────────────────────────────────────────────────
    {
        network: "bch",
        address: "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2",
        note: "legacy P2PKH",
    },
    {
        network: "bch",
        address: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
        note: "CashAddr with prefix — spec vector",
    },
    {
        network: "bch",
        address: "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
        note: "CashAddr without prefix — what wallets copy",
    },
    {
        network: "bch",
        address: "bitcoincash:pq4ql3ph6738xuv2cycduvkpu4rdwqge5q2uxdfg6f",
        note: "CashAddr P2SH",
    },

    // ── Dogecoin ─────────────────────────────────────────────────────────
    {
        network: "doge",
        address: "DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L",
        note: "P2PKH D — Robinhood cold wallet",
    },
    {
        network: "doge",
        address: "9vrDKvSN1KQLbnLYXQPmyDdRyKhUEbCXFo",
        note: "P2SH starting 9",
    },
    {
        network: "doge",
        address: "A7NSLLFpe3JvbCH8dfoTAZvJnLcSfLK5jU",
        note: "P2SH starting A",
    },

    // ── Dash ─────────────────────────────────────────────────────────────
    {
        network: "dash",
        address: "XpESxaUmonkq8RaLLp46Brx2K39ggQe226",
        note: "P2PKH X",
    },
    {
        network: "dash",
        address: "7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh",
        note: "P2SH starting 7",
    },

    // ── EVM ──────────────────────────────────────────────────────────────
    {
        network: "eth",
        address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        note: "vitalik.eth, EIP-55 mixed case",
    },
    {
        network: "eth",
        address: "0xdac17f958d2ee523a2206206994597c13d831ec7",
        note: "USDT contract, all lowercase",
    },
    {
        network: "base",
        address: "0x4200000000000000000000000000000000000006",
        note: "Base WETH predeploy",
    },

    // ── Solana ───────────────────────────────────────────────────────────
    {
        network: "sol",
        address: "So11111111111111111111111111111111111111112",
        note: "wrapped SOL mint",
    },
    {
        network: "sol",
        address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        note: "USDC mint",
    },
    {
        network: "sol",
        address: "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9",
        note: "Binance hot wallet",
    },

    // ── Tron ─────────────────────────────────────────────────────────────
    {
        network: "tron",
        address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        note: "TRC20 USDT contract",
    },
    {
        network: "tron",
        address: "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9",
        note: "Binance hot wallet",
    },

    // ── XRP ──────────────────────────────────────────────────────────────
    {
        network: "xrp",
        address: "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
        note: "genesis account",
    },
    {
        network: "xrp",
        address: "rEb8TK3gBgk5auZkwc6sHnwrGVJH8DuaLh",
        note: "Binance hot wallet",
    },
    {
        network: "xrp",
        address: "rN7n7otQDd6FczFgLdSqtcsAUxDkw6fzRH",
        note: "shorter valid account",
    },

    // ── Stellar ──────────────────────────────────────────────────────────
    {
        network: "stellar",
        address: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
        note: "SDF account",
    },
    {
        network: "stellar",
        address: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFSHONUCEOASW7QC7OX2H",
        note: "documented example account",
    },

    // ── TON ──────────────────────────────────────────────────────────────
    {
        network: "ton",
        address: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
        note: "bounceable EQ",
    },
    {
        network: "ton",
        address: "UQAX2eBUYlF9dTUKhDLtCa9Q6i0Ac1Iq7SsGvbcJhhVWSSaG",
        note: "non-bounceable UQ",
    },
    {
        network: "ton",
        address:
            "0:83dfd552e6372da472fcbcc8c45ebcc669170255862da1d751f27a7003a0f31a",
        note: "raw form, sometimes pasted",
    },

    // ── Cardano ──────────────────────────────────────────────────────────
    {
        network: "cardano",
        address:
            "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
        note: "Shelley base address",
    },
    {
        network: "cardano",
        address:
            "DdzFFzCqrhsf6hiTY8K7AVWKQPmwZBbfLPKcx400EMBqfoWr5pT7GxSTxU5DsDN4KsjqQzZ6XxbSMHZ7oW6QjJ2fhWTKhKLXKEmYyGCa",
        note: "Byron legacy address",
    },

    // ── Zcash ────────────────────────────────────────────────────────────
    {
        network: "zcash",
        address: "t1KDCRdkTRDPoSCTkfd6zsvhWLWG5Wxjfqx",
        note: "transparent t1",
    },
    {
        network: "zcash",
        address: "t3Vz22vK5z2LcKEdg16Yv4FFneEL1zg9ojd",
        note: "transparent t3 P2SH",
    },

    // ── Sui / Aptos / Starknet ───────────────────────────────────────────
    {
        network: "sui",
        address: "0x2::sui::SUI".split("::")[0].padEnd(2, "0"),
        note: "short 0x2 — Sui system object",
    },
    {
        network: "sui",
        address:
            "0x0000000000000000000000000000000000000000000000000000000000000002",
        note: "Sui framework, padded",
    },
    { network: "aptos", address: "0x1", note: "Aptos framework account" },
    {
        network: "starknet",
        address:
            "0x049d36570d4e46f48e99674bd3fcc84644ddd6b96f7c741b1562b82f9e004dc7",
        note: "Starknet ETH token",
    },
];

let failures = 0;
for (const sample of samples) {
    const issue = checkRecipientAddressFormat({
        address: sample.address,
        network: sample.network,
    });
    const status = issue === null ? "ok  " : "FAIL";
    if (issue) failures += 1;
    console.log(
        `${status} ${sample.network.padEnd(9)} ${(issue ?? "").padEnd(20)} ${sample.note}\n     ${sample.address}`,
    );
}
console.log(`\n${failures} rejected out of ${samples.length}`);
