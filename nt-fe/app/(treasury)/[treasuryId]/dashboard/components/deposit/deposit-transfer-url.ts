import { formatAssetForIntentsAPI } from "@/app/(treasury)/[treasuryId]/exchange/utils";
import type { ConfidentialOrigin } from "./deposit-types";

export type PayShareKind = "public" | "confidential";

/**
 * Standalone pay share page query shape.
 *
 * Confidential one-time: only `id` (quote deposit address). Asset, expiry, and
 * used/expired come from the status API; bridge address is re-derived.
 * Public treasury: `id` is the bridge address plus token/network for display.
 * Confidential reusable: dao from path; `source` selects Trezu vs near.com copy.
 */
export type PayShareQuery =
    | {
          kind: "public";
          /** Quote deposit address (confidential) or bridge address (public treasury). */
          id: string;
          /** Required for public treasuries (no status API). */
          token?: string;
          network?: string;
      }
    | {
          kind: "confidential";
          source: ConfidentialOrigin;
      };

export function buildPaySharePath(
    treasuryId: string,
    query: PayShareQuery,
): string {
    const params = new URLSearchParams();

    if (query.kind === "public") {
        params.set("id", query.id);
        if (query.token) params.set("token", query.token);
        if (query.network) params.set("network", query.network);
    } else {
        params.set("source", query.source);
    }

    const search = params.toString();
    return `/${treasuryId}/pay/${query.kind}${search ? `?${search}` : ""}`;
}

export function getAbsoluteTransferUrl(path: string): string {
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path}`;
}

export function parsePayShareKind(
    value: string | null | undefined,
): PayShareKind | null {
    if (value === "public" || value === "confidential") return value;
    return null;
}

/** Resume Pay-with-Trezu treasury picker after login. */
export const CHOOSE_PAYER_QUERY = "choosePayer";

export function withChoosePayerParam(pathWithSearch: string): string {
    const url = new URL(pathWithSearch, "https://trezu.app");
    url.searchParams.set(CHOOSE_PAYER_QUERY, "1");
    return `${url.pathname}${url.search}`;
}

/** Strip post-login resume flag so shared/copied links stay inert. */
export function withoutChoosePayerParam(pathWithSearch: string): string {
    const url = new URL(pathWithSearch, "https://trezu.app");
    url.searchParams.delete(CHOOSE_PAYER_QUERY);
    return `${url.pathname}${url.search}`;
}

export function hasChoosePayerParam(pathWithSearch: string): boolean {
    try {
        return (
            new URL(pathWithSearch, "https://trezu.app").searchParams.get(
                CHOOSE_PAYER_QUERY,
            ) === "1"
        );
    } catch {
        return false;
    }
}

/**
 * Deposit modal deep link (`/dashboard/deposit`).
 * Public treasuries may prefill `token` (asset/contract id) + `network`
 * (intents id or chain name). Confidential should omit params so the user
 * walks the source/ack flow without skipping reading.
 */
export type DepositDeepLinkParams = {
    token?: string;
    network?: string;
};

export function buildDepositDeepLink(
    treasuryId: string,
    params?: DepositDeepLinkParams | null,
): string {
    const search = new URLSearchParams();
    if (params?.token) search.set("token", params.token);
    if (params?.network) search.set("network", params.network);
    const qs = search.toString();
    return `/${treasuryId}/dashboard/deposit${qs ? `?${qs}` : ""}`;
}

/**
 * Shared `/payments` deep-link query.
 *
 * Exact pick: `token=<assetId>&network=<intentsNetworkId>` (+ optional address/name).
 * Soft prefs: `networks=eth,near` or `networks=near.com` (+ optional token/address/name).
 * Never emit both `network` and `networks`. Never put a JSON blob in `token`.
 */
export type PaymentsDeepLinkParams = {
    /** Recipient address when known (Pay-with-Trezu, address book). */
    address?: string;
    /** Optional recipient display name (address book). */
    name?: string;
    /** Bridge asset id (e.g. "usdc") — never a JSON blob. */
    token?: string;
    /** Singular intents network id for exact match (`eth:1:0x…` / `nep141:…`). */
    network?: string;
    /**
     * Soft chain preferences (address book) or confidential `near.com`.
     * Do not use for exact intents ids — use `network` instead.
     */
    networks?: string | string[];
};

/** Shared `/payments` deep link used by Pay-with-Trezu, address book, assets, etc. */
export function buildPaymentsDeepLink(
    treasuryId: string,
    params: PaymentsDeepLinkParams,
): string {
    const search = new URLSearchParams();
    if (params.address) search.set("address", params.address);
    if (params.name) search.set("name", params.name);
    if (params.token) search.set("token", params.token);
    if (params.network) search.set("network", params.network);
    if (params.networks) {
        const networks = Array.isArray(params.networks)
            ? params.networks.join(",")
            : params.networks;
        if (networks) search.set("networks", networks);
    }
    const qs = search.toString();
    return `/${treasuryId}/payments${qs ? `?${qs}` : ""}`;
}

/**
 * Assets-table / details Send link.
 * Exact for Intents or Ft (has contract id); soft chain pref otherwise.
 */
export function buildPaymentsDeepLinkForAsset(
    treasuryId: string,
    params: {
        assetId: string;
        /** `contractId ?? id` from the treasury network row. */
        networkId: string;
        networkName: string;
        /** Treasury/bridge residency on that row. */
        residency: string;
    },
): string {
    const token = params.assetId.trim();
    const networkId = params.networkId.trim();
    const useExact =
        !!networkId &&
        (params.residency === "Intents" || params.residency === "Ft");

    if (useExact) {
        return buildPaymentsDeepLink(treasuryId, {
            token,
            // Ft stores bare contracts; Intents ids are already canonical
            // (`nep141:…` / `eth:1:…`) and must not be re-prefixed.
            network:
                params.residency === "Ft"
                    ? formatAssetForIntentsAPI(networkId)
                    : networkId,
        });
    }
    return buildPaymentsDeepLink(treasuryId, {
        token,
        networks: params.networkName,
    });
}
