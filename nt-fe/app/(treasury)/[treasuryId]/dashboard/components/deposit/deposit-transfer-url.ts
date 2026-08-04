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
