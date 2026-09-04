import { createHash } from "node:crypto";
import { validateAddress } from "./lib/address-validation";
import type { BlockchainType } from "./lib/blockchain-utils";

const BASE = "https://1click.chaindefuser.com";

// ---------------------------------------------------------------- encoders
const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function polymod(values: number[]): number {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
        const b = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
    }
    return chk;
}

function hrpExpand(hrp: string): number[] {
    const out: number[] = [];
    for (const c of hrp) out.push(c.charCodeAt(0) >> 5);
    out.push(0);
    for (const c of hrp) out.push(c.charCodeAt(0) & 31);
    return out;
}

function convertBits(data: number[], from: number, to: number): number[] {
    let acc = 0;
    let bits = 0;
    const out: number[] = [];
    const maxv = (1 << to) - 1;
    for (const value of data) {
        acc = (acc << from) | value;
        bits += from;
        while (bits >= to) {
            bits -= to;
            out.push((acc >> bits) & maxv);
        }
    }
    if (bits > 0) out.push((acc << (to - bits)) & maxv);
    return out;
}

/** Segwit address: bech32 for v0, bech32m for v1+. */
function segwitAddress(hrp: string, version: number, program: number[]) {
    const data = [version, ...convertBits(program, 8, 5)];
    const constant = version === 0 ? 1 : 0x2bc830a3;
    const mod =
        polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ constant;
    const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
    return `${hrp}1${[...data, ...checksum].map((d) => BECH32_CHARSET[d]).join("")}`;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function base58check(version: number, payload: Buffer): string {
    const body = Buffer.concat([Buffer.from([version]), payload]);
    const checksum = createHash("sha256")
        .update(createHash("sha256").update(body).digest())
        .digest()
        .subarray(0, 4);
    const full = Buffer.concat([body, checksum]);

    let num = BigInt(`0x${full.toString("hex")}`);
    let out = "";
    while (num > 0n) {
        out = B58[Number(num % 58n)] + out;
        num /= 58n;
    }
    for (const byte of full) {
        if (byte !== 0) break;
        out = `1${out}`;
    }
    return out;
}

/** Deterministic pseudo-random bytes so runs are reproducible. */
function bytes(seed: string, length: number): number[] {
    const digest = createHash("sha256").update(seed).digest();
    return [...digest.subarray(0, length)];
}

const hash20 = (seed: string) => Buffer.from(bytes(seed, 20));

// ------------------------------------------------------------------ tokens
type TokenItem = { assetId: string; blockchain: string; symbol: string };
const tokens: TokenItem[] = await (await fetch(`${BASE}/v0/tokens`)).json();

function assetFor(blockchain: string): TokenItem | undefined {
    const onChain = tokens.filter((t) => t.blockchain === blockchain);
    return (
        onChain.find(
            (t) => t.symbol.toUpperCase() === blockchain.toUpperCase(),
        ) ??
        onChain.find((t) => t.symbol === "USDC") ??
        onChain[0]
    );
}

const origin = tokens.find(
    (t) => t.blockchain === "near" && t.symbol === "USDC",
);
if (!origin) throw new Error("no NEAR USDC origin asset");

// -------------------------------------------------------------- candidates
type Candidate = {
    chain: string;
    ours: BlockchainType;
    address: string;
    note: string;
};

const candidates: Candidate[] = [
    // Litecoin: bech32 forms are the modern default in Litecoin Core.
    {
        chain: "ltc",
        ours: "litecoin",
        address: segwitAddress("ltc", 0, bytes("ltc-p2wpkh", 20)),
        note: "ltc1 P2WPKH",
    },
    {
        chain: "ltc",
        ours: "litecoin",
        address: segwitAddress("ltc", 0, bytes("ltc-p2wsh", 32)),
        note: "ltc1 P2WSH",
    },
    {
        chain: "ltc",
        ours: "litecoin",
        address: segwitAddress("ltc", 1, bytes("ltc-taproot", 32)),
        note: "ltc1p taproot",
    },
    {
        chain: "ltc",
        ours: "litecoin",
        address: base58check(48, hash20("ltc-p2pkh")),
        note: "legacy L",
    },
    {
        chain: "ltc",
        ours: "litecoin",
        address: base58check(50, hash20("ltc-p2sh")),
        note: "P2SH M",
    },
    {
        chain: "ltc",
        ours: "litecoin",
        address: base58check(5, hash20("ltc-p2sh-old")),
        note: "P2SH legacy 3",
    },

    // Dogecoin / Dash P2SH variants.
    {
        chain: "doge",
        ours: "dogecoin",
        address: base58check(30, hash20("doge-p2pkh")),
        note: "P2PKH D",
    },
    {
        chain: "doge",
        ours: "dogecoin",
        address: base58check(22, hash20("doge-p2sh")),
        note: "P2SH 9/A",
    },
    {
        chain: "dash",
        ours: "dash",
        address: base58check(76, hash20("dash-p2pkh")),
        note: "P2PKH X",
    },
    {
        chain: "dash",
        ours: "dash",
        address: base58check(16, hash20("dash-p2sh")),
        note: "P2SH 7",
    },

    // Bitcoin forms.
    {
        chain: "btc",
        ours: "bitcoin",
        address: base58check(0, hash20("btc-p2pkh")),
        note: "P2PKH 1",
    },
    {
        chain: "btc",
        ours: "bitcoin",
        address: base58check(5, hash20("btc-p2sh")),
        note: "P2SH 3",
    },
    {
        chain: "btc",
        ours: "bitcoin",
        address: segwitAddress("bc", 0, bytes("btc-p2wpkh", 20)),
        note: "bc1 P2WPKH",
    },
    {
        chain: "btc",
        ours: "bitcoin",
        address: segwitAddress("bc", 0, bytes("btc-p2wsh", 32)),
        note: "bc1 P2WSH",
    },
    {
        chain: "btc",
        ours: "bitcoin",
        address: segwitAddress("bc", 1, bytes("btc-taproot", 32)),
        note: "bc1p taproot",
    },

    // Bitcoin Cash: wallets copy CashAddr with and without the prefix.
    {
        chain: "bch",
        ours: "bitcoincash",
        address: "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
        note: "cashaddr no prefix",
    },
    {
        chain: "bch",
        ours: "bitcoincash",
        address: "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a",
        note: "cashaddr with prefix",
    },
    {
        chain: "bch",
        ours: "bitcoincash",
        address: base58check(0, hash20("bch-legacy")),
        note: "legacy 1",
    },

    // TON: friendly (UQ/EQ) and raw workchain forms.
    {
        chain: "ton",
        ours: "ton",
        address: "EQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqB2N",
        note: "EQ friendly",
    },
    {
        chain: "ton",
        ours: "ton",
        address: "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqHqB",
        note: "UQ friendly",
    },
    {
        chain: "ton",
        ours: "ton",
        address:
            "0:83dfd552e6372da472fcbcc8c45ebcc669170255862da1d751f27a7003a0f31a",
        note: "raw workchain 0",
    },
    {
        chain: "ton",
        ours: "ton",
        address:
            "-1:83dfd552e6372da472fcbcc8c45ebcc669170255862da1d751f27a7003a0f31a",
        note: "raw masterchain -1",
    },

    // Others worth confirming.
    {
        chain: "sui",
        ours: "sui",
        address:
            "0x02a212de6a9dfa3a69e22387acfbafbb1a9e591bd9d636e7895dcfc8de05f331",
        note: "full 32-byte",
    },
    { chain: "sui", ours: "sui", address: "0x2", note: "short 0x2" },
    { chain: "aptos", ours: "aptos", address: "0x1", note: "short 0x1" },
    {
        chain: "aptos",
        ours: "aptos",
        address:
            "0x1b9d5a2f04d2b0d8d8e42f2b7f4f0e0b06b2c9b7e2c9c0f1a2b3c4d5e6f70819",
        note: "full 32-byte",
    },
    {
        chain: "stellar",
        ours: "stellar",
        address: "GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37",
        note: "G account",
    },
    {
        chain: "stellar",
        ours: "stellar",
        address:
            "MDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4AAAAAAAAAAAAAJLK",
        note: "M muxed",
    },
    {
        chain: "xrp",
        ours: "xrp",
        address: "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv",
        note: "r classic",
    },
    {
        chain: "xrp",
        ours: "xrp",
        address: "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ",
        note: "X-address (tag encoded)",
    },
    {
        chain: "cardano",
        ours: "cardano",
        address:
            "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x",
        note: "Shelley addr1",
    },
    {
        chain: "zec",
        ours: "zcash",
        address: "t1KsBQpAhFqiwpUAEXPn8v1PFXf2Ph6dJhP",
        note: "t1 transparent",
    },
    {
        chain: "tron",
        ours: "tron",
        address: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        note: "T address",
    },
    {
        chain: "sol",
        ours: "solana",
        address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
        note: "base58",
    },
    {
        chain: "eth",
        ours: "ethereum",
        address: "0x742d35Cc6634C0532925a3b844Bc454e4438f44e",
        note: "checksummed",
    },
];

const deadline = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const mismatches: string[] = [];

for (const candidate of candidates) {
    const destination = assetFor(candidate.chain);
    if (!destination) {
        console.log(`SKIP  ${candidate.chain} — no 1Click asset`);
        continue;
    }

    const res = await fetch(`${BASE}/v0/quote`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            dry: true,
            swapType: "EXACT_INPUT",
            slippageTolerance: 100,
            originAsset: origin.assetId,
            depositType: "ORIGIN_CHAIN",
            destinationAsset: destination.assetId,
            amount: "100000000",
            refundTo: "trezu.sputnik-dao.near",
            refundType: "ORIGIN_CHAIN",
            recipient: candidate.address,
            recipientType: "DESTINATION_CHAIN",
            deadline,
        }),
    });
    const text = await res.text();
    let detail = text;
    try {
        const parsed = JSON.parse(text);
        detail = parsed.message ?? parsed.error ?? "";
    } catch {}
    if (Array.isArray(detail)) detail = detail.join("; ");

    const oneClickOk = res.ok;
    const oursOk = validateAddress(candidate.address, candidate.ours).isValid;
    const agree = oneClickOk === oursOk;
    const line = `${agree ? "  ok  " : " DIFF "} ${candidate.chain.padEnd(8)} 1click=${(oneClickOk ? "accept" : `reject(${res.status})`).padEnd(10)} ours=${oursOk ? "accept" : "reject"}  ${candidate.note}\n         ${candidate.address}${oneClickOk ? "" : `\n         -> ${String(detail).slice(0, 120)}`}`;
    console.log(line);
    if (!agree) mismatches.push(line);

    await new Promise((r) => setTimeout(r, 350));
}

console.log(`\n===== ${mismatches.length} mismatches =====`);
for (const line of mismatches) console.log(line);
