import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { canChangePolicy, hasPermission } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";

/**
 * The current account's access tiers for the Request Templates feature, mirroring the nt-be gates.
 * Per issue #1046 authoring is a Requestor capability, not admin-only — only deletion stays admin:
 *  - `canPropose` — fill a template into a proposal. Templates always build a `FunctionCall`
 *    (see `buildTemplateProposal`), so this is specifically `call:AddProposal` — NOT the broader
 *    `isRequestor` (call OR transfer): a transfer-only requestor could never file a template request.
 *  - `isAdmin`    — holds the DAO's policy-management capability (`canChangePolicy`). nt-be gates
 *    template *deletion* on this (`ChangePolicy`); it also covers create/edit.
 *  - `canAuthor`  — create/edit/pin a template. nt-be gates these on `AddProposal`, so a Requestor
 *    (`canPropose`) qualifies, as does an admin. Union of the two.
 *  - `canDelete`  — delete a template: admin only (`isAdmin`).
 *  - `canAccess`  — may see the templates list at all (anyone who can author == propose or admin).
 *
 * Used to hide affordances a member can't act on. Writes stay enforced server-side; this only
 * aligns the UI so no one is walked into a form/action the backend will 403.
 */
export function useCustomTemplatesAccess() {
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy, isLoading } = useTreasuryPolicy(treasuryId);

    const isAdmin =
        !!policy && !!accountId && canChangePolicy(policy, accountId);
    const canPropose =
        !!policy &&
        !!accountId &&
        hasPermission(policy, accountId, "call", "AddProposal");
    const canAuthor = canPropose || isAdmin;

    return {
        isLoading,
        canPropose,
        canAuthor,
        canDelete: isAdmin,
        isAdmin,
        canAccess: canAuthor,
    };
}
