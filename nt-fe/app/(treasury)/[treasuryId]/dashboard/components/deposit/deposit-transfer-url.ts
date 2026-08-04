import type { ConfidentialOrigin } from "./deposit-types";

/**
 * Transfer page query shape.
 *
 * Public (from a public wallet): address + token + network ids — everything else
 * (symbol, icons, min deposit, display names) is resolved from bridge tokens.
 * Confidential (from Trezu / near.com): dao id comes from the path; `source`
 * selects the Trezu vs near.com copy.
 */
export type TransferQuery =
    | {
          type: "public";
          /** One-time bridge deposit address. */
          address: string;
          /** Bridge asset id (e.g. "usdc"). */
          token: string;
          /** Bridge network / intents token id. */
          network: string;
      }
    | {
          type: "confidential";
          source: ConfidentialOrigin;
      };

export function buildDepositTransferPath(
    treasuryId: string,
    query: TransferQuery,
): string {
    const params = new URLSearchParams();
    params.set("type", query.type);

    if (query.type === "public") {
        params.set("address", query.address);
        params.set("token", query.token);
        params.set("network", query.network);
    } else {
        params.set("source", query.source);
    }

    return `/${treasuryId}/deposit/transfer?${params.toString()}`;
}

export function getAbsoluteTransferUrl(path: string): string {
    if (typeof window === "undefined") return path;
    return `${window.location.origin}${path}`;
}

export function parseTransferType(
    value: string | null,
    hints?: { hasPublicParams?: boolean },
): "public" | "confidential" {
    if (value === "confidential") return "confidential";
    // "one-time" kept as a legacy alias while old links may still exist.
    if (value === "public" || value === "one-time") return "public";
    // Infer public when the URL carries public-wallet fields but omits type.
    if (hints?.hasPublicParams) return "public";
    return "confidential";
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

export function buildPayWithTrezuPaymentsPath(
    payerTreasuryId: string,
    params: { address: string; networks: string },
): string {
    const search = new URLSearchParams({
        address: params.address,
        networks: params.networks,
    });
    return `/${payerTreasuryId}/payments?${search.toString()}`;
}
