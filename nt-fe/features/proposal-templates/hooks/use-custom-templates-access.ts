import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import {
    canChangePolicy,
    hasActionPermission,
    hasPermission,
} from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";

/**
 * The current account's access tiers for the Request Templates feature. Each tier mirrors the exact
 * nt-be gate it shadows, so the UI never offers an action the backend will 403 (per issue #1046,
 * authoring is a Requestor capability, not admin-only; only deletion stays admin):
 *  - `canAuthor`  — create/edit/pin a template. nt-be gates these on the `AddProposal` action, so
 *    this mirrors that (action-only) matcher directly — Requestors and admins qualify, a synthetic
 *    `*:ChangePolicy` (which nt-be would 403 on create) does NOT.
 *  - `isAdmin` / `canDelete` — nt-be gates template deletion + the feature flag on `ChangePolicy`.
 *  - `canPropose` — FILE a template into a proposal. Templates build a `FunctionCall`
 *    (`buildTemplateProposal`) that is submitted on-chain, so this needs `call:AddProposal`
 *    specifically — narrower than `canAuthor`, and a transfer-only requestor can author but not file.
 *  - `canAccess`  — may see the list at all (can author or propose).
 *
 * Writes stay enforced server-side; this only aligns the UI so no one is walked into a dead action.
 */
export function useCustomTemplatesAccess() {
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy, isLoading } = useTreasuryPolicy(treasuryId);

    const canAuthor =
        !!policy &&
        !!accountId &&
        hasActionPermission(policy, accountId, "AddProposal");
    const isAdmin =
        !!policy && !!accountId && canChangePolicy(policy, accountId);
    const canPropose =
        !!policy &&
        !!accountId &&
        hasPermission(policy, accountId, "call", "AddProposal");

    return {
        isLoading,
        canPropose,
        canAuthor,
        canDelete: isAdmin,
        isAdmin,
        canAccess: canAuthor || canPropose,
    };
}
