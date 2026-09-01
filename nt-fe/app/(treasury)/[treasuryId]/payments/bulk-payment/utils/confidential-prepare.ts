/**
 * Review-time prepare lifecycle for confidential bulk payments.
 *
 * The prepare endpoint fetches firm 1Click quotes, so it runs once when the
 * review step loads and its response is both the fee source for the review
 * UI and the payload the confirm button submits from — display and
 * submission can never disagree. This module owns that lifecycle: payment
 * payload in, status + prepared result out. React wiring lives in
 * `use-confidential-prepare.ts`.
 */

import { isAxiosError } from "axios";
import type {
    BulkPaymentLegQuote,
    BulkPaymentPrepareRequest,
    BulkPaymentPrepareResponse,
} from "@/lib/api";
import Big from "@/lib/big";
import { isEthImplicitNearAddress } from "@/lib/near-address-format";
import { stripNearComAddressPrefix } from "@/lib/nearcom-address";

/** Same as public quote: bare account; eth-implicit 0x… lowercased for 1Click. */
function normalizePrepareRecipient(recipient: string): string {
    const bare = stripNearComAddressPrefix(recipient);
    return isEthImplicitNearAddress(bare) ? bare.toLowerCase() : bare;
}

// ─── Request building ───

/**
 * Map the review-step payment list to the prepare request. Each recipient
 * amount is padded by the locally estimated network fee so the BE can keep
 * using EXACT_INPUT 1Click quotes — the sub will always hold enough to
 * cover the withdrawal, and the recipient nets ~the typed amount. NEAR.COM
 * (intra-Intents) legs have no fee. Displayed fees do NOT come from this
 * padding — they come from the quotes in the prepare response.
 */
export function buildPrepareRequest(args: {
    daoId: string;
    token: { address: string; decimals: number };
    payments: Array<{ recipient: string; amount: string }>;
    networkFeePerRecipient: string | null;
    toNearCom: boolean;
    /** Cross-chain destination asset id; ignored when toNearCom is true. */
    destinationAsset?: string;
}): BulkPaymentPrepareRequest {
    const feePerRecipient = args.networkFeePerRecipient
        ? Big(args.networkFeePerRecipient)
        : Big(0);
    return {
        daoId: args.daoId,
        originAsset: args.token.address,
        toNearCom: args.toNearCom,
        destinationAsset: args.toNearCom ? undefined : args.destinationAsset,
        decimals: args.token.decimals,
        payments: args.payments.map((p) => ({
            recipient: normalizePrepareRecipient(p.recipient),
            amount: Big(p.amount || "0")
                .add(feePerRecipient)
                .times(Big(10).pow(args.token.decimals))
                .toFixed(0),
        })),
    };
}

// ─── Fee derivation ───

export interface QuoteFees {
    /** Transfer fee per recipient leg (token units), same order as recipients. */
    perRecipientFees: Big[];
    /** Total fee across all legs (recipients + header), token units. */
    totalNetworkFee: Big;
}

const legFee = (quote: BulkPaymentLegQuote) =>
    Big(quote.amountInFormatted).minus(Big(quote.amountOutFormatted));

/**
 * Real transfer fees locked in by the firm quotes: what each leg is charged
 * minus what it delivers. Formatted amounts are diffed (instead of raw
 * smallest units) because origin and destination chains may use different
 * decimals for the same token.
 */
export function deriveQuoteFees(
    response: Pick<
        BulkPaymentPrepareResponse,
        "recipientQuotes" | "headerQuote"
    >,
): QuoteFees {
    const perRecipientFees = response.recipientQuotes.map(legFee);
    const totalNetworkFee = perRecipientFees.reduce(
        (sum, fee) => sum.add(fee),
        legFee(response.headerQuote),
    );
    return { perRecipientFees, totalNetworkFee };
}

/** Largest per-recipient withdrawal fee from firm quotes (token units). */
export function maxQuotedRecipientFee(fees: QuoteFees): Big {
    return fees.perRecipientFees.reduce(
        (max, fee) => (fee.gt(max) ? fee : max),
        Big(0),
    );
}

/**
 * True when the firm quote fee exceeds the pad used for EXACT_INPUT — the
 * recipient would under-receive vs the typed amount until we re-pad and
 * re-prepare.
 */
export function needsFeeRepad(
    currentPad: string | null | undefined,
    fees: QuoteFees,
): boolean {
    const pad = currentPad ? Big(currentPad) : Big(0);
    const maxFee = maxQuotedRecipientFee(fees);
    // Tiny epsilon avoids churn on float/decimal noise between quote rounds.
    return maxFee.gt(pad.plus("0.0000001"));
}

// ─── Error classification ───

/**
 * True when prepare was rejected because the treasury has no batch-payment
 * credits left (HTTP 402). The review flow gates on the subscription before
 * calling prepare, so this only fires when credits ran out between that
 * check and the call — it renders as "out of credits", not as a retryable
 * quote failure.
 */
export function isOutOfCreditsError(error: unknown): boolean {
    return isAxiosError(error) && error.response?.status === 402;
}

// ─── Prepare lifecycle ───

export type PrepareState =
    | { status: "idle" }
    | { status: "loading" }
    | { status: "success"; data: BulkPaymentPrepareResponse }
    | { status: "error"; error: unknown };

const IDLE: PrepareState = { status: "idle" };

/**
 * Single-flight controller around the prepare call: fires when a payment
 * payload is set, re-fires when the payload changes (edit-and-return),
 * discards in-flight responses the moment the payload changes or clears
 * (leaving review), and retries on demand after a failure. Each prepare
 * call creates firm quotes on the backend, so identical payloads are
 * deduplicated and nothing auto-refreshes.
 */
export function createPrepareController(
    fetchPrepare: (
        request: BulkPaymentPrepareRequest,
    ) => Promise<BulkPaymentPrepareResponse>,
) {
    let state: PrepareState = IDLE;
    let request: BulkPaymentPrepareRequest | null = null;
    let requestKey: string | null = null;
    // Bumped on every (re)fire and payload change; a resolved call only
    // lands if its generation is still current, so stale responses from an
    // abandoned payload can never attach to an edited payment list.
    let generation = 0;
    const listeners = new Set<() => void>();

    const transition = (next: PrepareState) => {
        state = next;
        for (const listener of listeners) listener();
    };

    const fire = () => {
        if (!request) return;
        const gen = ++generation;
        transition({ status: "loading" });
        fetchPrepare(request).then(
            (data) => {
                if (gen === generation) transition({ status: "success", data });
            },
            (error) => {
                if (gen === generation) transition({ status: "error", error });
            },
        );
    };

    return {
        /**
         * Set the payment payload to quote, or null when prepare shouldn't
         * run (non-confidential flow, not on the review step). Deduped by
         * content, so callers may pass a freshly built object every render.
         */
        setRequest(next: BulkPaymentPrepareRequest | null) {
            const key = next ? JSON.stringify(next) : null;
            if (key === requestKey) return;
            requestKey = key;
            request = next;
            if (next) {
                fire();
            } else {
                generation++;
                transition(IDLE);
            }
        },
        /** Re-fire the current payload after a failure. */
        retry() {
            fire();
        },
        getState: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
