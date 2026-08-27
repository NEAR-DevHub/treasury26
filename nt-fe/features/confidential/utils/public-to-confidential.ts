import type { Token } from "@/components/token-input";
import { NEAR_COM_NETWORK_ID, NEAR_NETWORK_ID } from "@/constants/network-ids";
import { PUBLIC_TO_CONFIDENTIAL_ACTION } from "@/constants/proposal-actions";
import { getProposalUIKind } from "@/features/proposals/utils/proposal-utils";
import { buildIntentsQuoteRequest } from "@/hooks/use-intents-quote";
import { baseUnitsFromDecimal, decimalOrNull } from "@/lib/amount-format";
import {
    getIntentsQuote,
    type IntentsQuoteRequest,
    type IntentsQuoteResponse,
    type TreasuryAsset,
} from "@/lib/api";
import { availableBalance } from "@/lib/balance";
import {
    buildIntentsTransferProposal,
    buildNativeNearIntentsKind,
    buildNearFtIntentsKind,
    parseIntentsDepositKind,
} from "@/lib/near-proposal-builders";
import { classifyPaymentToken } from "@/lib/payment-route";
import type { FunctionCallKind, Proposal } from "@/lib/proposals-api";
import { canonicalizeTokenIdForMatch, encodeToMarkdown } from "@/lib/utils";

export { PUBLIC_TO_CONFIDENTIAL_ACTION };

export type PublicAssetResidency = "Near" | "Ft" | "Intents";

export type PublicTransferAmountError =
    | "invalid"
    | "zero"
    | "tooManyDecimals"
    | "exceedsBalance";

/** `raw` is a canonical base-unit string (no exponent), as 1Click and
 * on-chain args expect it. */
export type PublicTransferAmount =
    | { ok: true; raw: string }
    | { ok: false; error: PublicTransferAmountError };

export class PublicToConfidentialError extends Error {
    constructor(
        readonly code:
            | "unsupportedAsset"
            | "missingDepositAddress"
            | "quoteUnavailable"
            | "amountMismatch"
            | "missingDeadline",
        message: string,
    ) {
        super(message);
        this.name = "PublicToConfidentialError";
    }
}

export interface PublicToConfidentialProposal {
    description: string;
    kind: FunctionCallKind;
}

export interface PublicToConfidentialTransfer {
    residency: PublicAssetResidency;
    tokenId: string;
    amountRaw: string;
    depositAddress: string;
}

function isPublicAssetResidency(
    residency: string | undefined,
): residency is PublicAssetResidency {
    return (
        residency === "Near" || residency === "Ft" || residency === "Intents"
    );
}

/**
 * Identity of a public asset row. The backend gives the on-chain and
 * intents versions of a token the same unified `id`, so residency + contract
 * is the only key that separates e.g. public USDC from public-intents USDC.
 */
export function publicAssetKey(
    asset: Pick<TreasuryAsset, "id" | "contractId" | "residency">,
): string {
    return `${asset.residency}:${canonicalizeTokenIdForMatch(asset.contractId ?? asset.id)}`;
}

/** Asset residency the recovery flow can move, or `null` for lockups/staking. */
export function publicAssetResidency(
    asset: Pick<TreasuryAsset, "residency" | "lockupInstanceId">,
): PublicAssetResidency | null {
    if (asset.lockupInstanceId || !isPublicAssetResidency(asset.residency)) {
        return null;
    }
    return asset.residency;
}

/**
 * Validate a user-entered decimal amount against the asset: positive, no more
 * fraction digits than the token supports, and within the available balance.
 */
export function parsePublicTransferAmount(
    input: string,
    asset: Pick<TreasuryAsset, "decimals" | "balance">,
): PublicTransferAmount {
    const decimal = decimalOrNull(input);
    if (!decimal) return { ok: false, error: "invalid" };
    if (decimal.lte(0)) return { ok: false, error: "zero" };

    const raw = baseUnitsFromDecimal(decimal, asset.decimals);
    if (!raw.eq(raw.round(0))) return { ok: false, error: "tooManyDecimals" };
    if (raw.gt(availableBalance(asset.balance))) {
        return { ok: false, error: "exceedsBalance" };
    }
    return { ok: true, raw: raw.toFixed(0) };
}

/**
 * Token-picker shape for a public treasury asset, as `classifyPaymentToken`
 * expects it: native NEAR keeps the `near` id, FT / Intents use the contract id.
 */
export function publicAssetToToken(asset: TreasuryAsset): Token {
    const residency = publicAssetResidency(asset);
    if (!residency) {
        throw new PublicToConfidentialError(
            "unsupportedAsset",
            `Asset ${asset.id} (${asset.residency}) cannot be moved`,
        );
    }
    const address =
        residency === "Near" ? NEAR_NETWORK_ID : (asset.contractId ?? asset.id);
    return {
        address,
        symbol: asset.symbol,
        decimals: asset.decimals,
        name: asset.name,
        icon: asset.icon,
        network: asset.network || NEAR_NETWORK_ID,
        chainIcons: asset.chainIcons,
        residency,
        price: asset.price,
        balance: availableBalance(asset.balance).toFixed(0),
        balanceAssetId: residency === "Intents" ? address : undefined,
    };
}

/**
 * 1Click quote moving a public balance into the DAO's own confidential
 * balance: public origin (`ORIGIN_CHAIN` for NEAR/FT, `INTENTS` for public
 * intents), same asset both sides, `EXACT_INPUT`, refunds back to the public
 * balance, recipient type `CONFIDENTIAL_INTENTS`.
 */
export function buildPublicToConfidentialQuoteRequest(
    treasuryId: string,
    asset: TreasuryAsset,
    amountRaw: string,
    proposalPeriod: string,
): IntentsQuoteRequest {
    const { tokenForIntentsQuote } = classifyPaymentToken(
        publicAssetToToken(asset),
    );
    return buildIntentsQuoteRequest(
        treasuryId,
        tokenForIntentsQuote,
        treasuryId,
        amountRaw,
        false,
        proposalPeriod,
        "total",
        NEAR_COM_NETWORK_ID,
        true,
        { confidentialRecipient: true },
    );
}

/**
 * Normal payment proposal that sends the public balance to the quote's
 * deposit address. The description carries only the marker — amounts and
 * the confidential recipient are not written on-chain.
 */
export function buildPublicToConfidentialProposal(params: {
    asset: TreasuryAsset;
    amountRaw: string;
    depositAddress: string;
    /** Optional user comment; stored as `notes` only when non-empty. */
    notes?: string;
}): PublicToConfidentialProposal {
    const { asset, amountRaw, depositAddress, notes } = params;
    if (!depositAddress) {
        throw new PublicToConfidentialError(
            "missingDepositAddress",
            "Quote did not return a deposit address",
        );
    }
    const token = publicAssetToToken(asset);
    const kind =
        token.residency === "Near"
            ? buildNativeNearIntentsKind(depositAddress, amountRaw)
            : token.residency === "Ft"
              ? buildNearFtIntentsKind(token.address, depositAddress, amountRaw)
              : buildIntentsTransferProposal(
                    token.address,
                    depositAddress,
                    amountRaw,
                );

    return {
        description: encodeToMarkdown({
            proposal_action: PUBLIC_TO_CONFIDENTIAL_ACTION,
            notes: notes?.trim() || undefined,
        }),
        kind,
    };
}

/**
 * Fetch a fresh wet quote and return it with the proposal payload. The
 * caller submits `proposal` through `createProposal` (multisig approval as
 * usual); nothing is executed here.
 */
export async function preparePublicToConfidentialTransfer(params: {
    treasuryId: string;
    asset: TreasuryAsset;
    amountRaw: string;
    proposalPeriod: string;
    notes?: string;
    fetchQuote?: typeof getIntentsQuote;
}): Promise<{
    quote: IntentsQuoteResponse;
    proposal: PublicToConfidentialProposal;
}> {
    const {
        treasuryId,
        asset,
        amountRaw,
        proposalPeriod,
        notes,
        fetchQuote = getIntentsQuote,
    } = params;
    const request = buildPublicToConfidentialQuoteRequest(
        treasuryId,
        asset,
        amountRaw,
        proposalPeriod,
    );
    const quote = await fetchQuote(request, false);
    if (!quote?.quote) {
        throw new PublicToConfidentialError(
            "quoteUnavailable",
            "Quote unavailable",
        );
    }
    if (!quote.quote.depositAddress) {
        throw new PublicToConfidentialError(
            "missingDepositAddress",
            "Quote did not return a deposit address",
        );
    }
    if (quote.quote.amountIn !== amountRaw) {
        throw new PublicToConfidentialError(
            "amountMismatch",
            `Quote amountIn ${quote.quote.amountIn} differs from requested ${amountRaw}`,
        );
    }
    if (!quote.quoteRequest?.deadline) {
        throw new PublicToConfidentialError(
            "missingDeadline",
            "Quote did not return a deadline",
        );
    }

    return {
        quote,
        proposal: buildPublicToConfidentialProposal({
            asset,
            amountRaw,
            depositAddress: quote.quote.depositAddress,
            notes,
        }),
    };
}

/**
 * Marker + exact builder call shape + backend-verified 1Click quote binding
 * (`confidential_metadata.public_move.verified`). Same rule as the requests
 * list classification.
 */
export function isPublicToConfidentialProposal(proposal: Proposal): boolean {
    return getProposalUIKind(proposal) === "Move to Confidential";
}

/**
 * Asset / amount / deposit address of a verified recovery proposal, decoded
 * from the FunctionCall args (the description intentionally carries none of it).
 */
export function extractPublicToConfidentialTransfer(
    proposal: Proposal,
): PublicToConfidentialTransfer | null {
    if (!isPublicToConfidentialProposal(proposal)) return null;
    return parseIntentsDepositKind(proposal.kind);
}
