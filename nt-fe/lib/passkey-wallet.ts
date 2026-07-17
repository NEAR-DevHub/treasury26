import type { NearConnector } from "@hot-labs/near-connect";
import type { WalletManifest } from "@hot-labs/near-connect/build/types";

/**
 * Bump with EVERY change to the published executor: near-connect caches
 * executor code in IndexedDB keyed by `id:version` and serves stale code
 * (refreshing in background) when the version doesn't change. The executor is
 * served from the frol-ai/near-connect-passkey main branch, so the URL is
 * stable while its bytes change — the version is the only cache-buster.
 */
const PASSKEY_EXECUTOR_VERSION = "1.0.1";

/**
 * Raw GitHub URL of the committed executor build on the
 * frol-ai/near-connect-passkey main branch — the same distribution model as
 * the other near-connect executors (e.g. near-connect-ledger).
 */
const PASSKEY_EXECUTOR_URL =
    "https://raw.githubusercontent.com/frol-ai/near-connect-passkey/refs/heads/master/passkey-executor.js";

/**
 * Trezu-local manifest for the Passkey wallet executor
 * (https://github.com/frol-ai/near-connect-passkey). Registered
 * programmatically instead of the shared near-connect manifest so the rollout
 * stays Trezu-only: passkeys are rpId-scoped to the dApp domain, so every dApp
 * must opt in with its own onboarding anyway.
 */
export function getPasskeyWalletManifest(): WalletManifest {
    return {
        id: "passkey",
        version: PASSKEY_EXECUTOR_VERSION,
        name: "Passkey",
        icon: "/icons/passkey.svg",
        description: "Sign in with Face ID, Touch ID, or your device passcode.",
        website: "https://trezu.app",
        executor: PASSKEY_EXECUTOR_URL,
        type: "sandbox",
        platform: ["web"],
        features: {
            signMessage: true,
            signTransaction: false,
            signAndSendTransaction: true,
            signAndSendTransactions: true,
            signInWithoutAddKey: true,
            signInAndSignMessage: true,
            signInWithFunctionCallKey: false,
            signDelegateActions: true,
            resolveAuth: true,
            mainnet: true,
            testnet: false,
        },
        permissions: {
            storage: true,
            webauthn: true,
        },
    } as WalletManifest;
}

/**
 * Idempotently registers the Passkey wallet on a connector
 * (`registerWallet` dedupes by manifest id). Registered wallets bypass the
 * `excludedWallets` filtering, so callers only invoke this when the Passkey
 * flow is actually targeted (direct-trigger card / restored session).
 */
export async function ensurePasskeyWallet(
    connector: NearConnector,
): Promise<void> {
    await connector.registerWallet(getPasskeyWalletManifest());
}
