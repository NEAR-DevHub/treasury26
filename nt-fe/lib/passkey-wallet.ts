import type { NearConnector } from "@hot-labs/near-connect";
import type { WalletManifest } from "@hot-labs/near-connect/build/types";

/**
 * Bump with EVERY change to the vendored executor artifact: near-connect
 * caches executor code in IndexedDB keyed by `id:version` and serves stale
 * code (refreshing in background) when the version doesn't change.
 */
const PASSKEY_EXECUTOR_VERSION = "1.0.0";

/**
 * Trezu-local manifest for the Passkey wallet executor
 * (https://github.com/near/near-connect-passkey), served from our own
 * origin like trezu-wallet.js. Registered programmatically instead of the
 * shared near-connect manifest so the rollout stays Trezu-only: passkeys
 * are rpId-scoped to the dApp domain, so every dApp must opt in with its
 * own onboarding anyway.
 */
export function getPasskeyWalletManifest(): WalletManifest {
    return {
        id: "passkey",
        version: PASSKEY_EXECUTOR_VERSION,
        name: "Passkey",
        icon: "/icons/passkey.svg",
        description: "Sign in with Face ID, Touch ID, or your device passcode.",
        website: "https://trezu.app",
        executor: `${window.location.origin}/_next/static/near-connect/passkey-executor.js`,
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
