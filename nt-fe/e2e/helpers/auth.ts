/**
 * Programmatic login helper for E2E setup.
 *
 * `create-stream` now requires an authenticated member (session cookie). Every
 * sandbox account is controlled by the genesis key, so we authenticate as a DAO
 * member by signing the login challenge with that key via NEP-413, exactly as a
 * wallet would, and return the resulting `auth_token` cookie for reuse.
 */
import { KeyPair } from "@near-js/crypto";
import { createHash, randomBytes } from "crypto";

// Same well-known near-sandbox genesis key used by sandbox-rpc.ts; it is the
// full-access key on test.near and every account created for the tests.
const GENESIS_PRIVATE_KEY =
    "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB";
const GENESIS_KEY_PAIR = KeyPair.fromString(GENESIS_PRIVATE_KEY);

// Must match the backend (auth/handlers.rs): purpose@recipient.
const SIGNED_RECIPIENT = "PROVE_OWNERSHIP@Trezu App";
const NEP413_TAG = 2 ** 31 + 413; // 2147484061

function u32le(n: number): Buffer {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0);
    return b;
}

function borshString(s: string): Buffer {
    const bytes = Buffer.from(s, "utf8");
    return Buffer.concat([u32le(bytes.length), bytes]);
}

/** Recompute the NEP-413 hash the backend verifies: sha256(tag ++ borsh(payload)). */
function nep413Hash(message: string, nonce: Buffer, recipient: string): Buffer {
    const payload = Buffer.concat([
        u32le(NEP413_TAG),
        borshString(message),
        nonce, // 32 raw bytes
        borshString(recipient),
        Buffer.from([0]), // callbackUrl: None
    ]);
    return createHash("sha256").update(payload).digest();
}

/**
 * Log in as `accountId` and return the `Cookie` header value (`auth_token=...`)
 * to attach to authenticated requests.
 */
export async function loginAndGetCookie(
    backendUrl: string,
    accountId: string,
): Promise<string> {
    const challengeResp = await fetch(`${backendUrl}/api/auth/challenge`, {
        method: "POST",
    });
    if (!challengeResp.ok) {
        throw new Error(
            `Failed to get auth challenge: ${challengeResp.status} ${await challengeResp.text()}`,
        );
    }
    const { payload: message } = (await challengeResp.json()) as {
        payload: string;
    };

    const nonce = randomBytes(32);
    const hash = nep413Hash(message, nonce, SIGNED_RECIPIENT);
    const { signature } = GENESIS_KEY_PAIR.sign(hash);

    const authorization = JSON.stringify({
        publicKey: GENESIS_KEY_PAIR.getPublicKey().toString(),
        signature: Buffer.from(signature).toString("base64"),
        message,
        recipient: SIGNED_RECIPIENT,
        nonce: nonce.toString("base64"),
    });

    const loginResp = await fetch(`${backendUrl}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId, authorization }),
    });
    if (!loginResp.ok) {
        throw new Error(
            `Login failed for ${accountId}: ${loginResp.status} ${await loginResp.text()}`,
        );
    }

    const headers = loginResp.headers as Headers & {
        getSetCookie?: () => string[];
    };
    const setCookies =
        typeof headers.getSetCookie === "function"
            ? headers.getSetCookie()
            : [headers.get("set-cookie") ?? ""];
    const authCookie = setCookies
        .map((c) => /(?:^|;\s*)(auth_token=[^;]+)/.exec(c)?.[1])
        .find(Boolean);
    if (!authCookie) {
        throw new Error(`Login for ${accountId} returned no auth_token cookie`);
    }
    return authCookie;
}
