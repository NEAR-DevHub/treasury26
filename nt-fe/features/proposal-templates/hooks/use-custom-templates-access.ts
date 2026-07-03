import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { canChangePolicy, isRequestor } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";

/**
 * The current account's access tiers for the Request Templates feature, mirroring the nt-be gates:
 *  - `canManage`  — author templates (create/edit/pin/delete). Backend gates these on `ChangePolicy`.
 *  - `canPropose` — fill a template into a proposal (Requestor: call/transfer `AddProposal`).
 *  - `canAccess`  — may see the templates list at all (either of the above).
 *
 * Used to hide authoring affordances from proposers and to keep the list out of reach of members who
 * can neither propose nor manage. Writes stay enforced server-side; this only aligns the UI.
 */
export function useCustomTemplatesAccess() {
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy, isLoading } = useTreasuryPolicy(treasuryId);

    const canManage =
        !!policy && !!accountId && canChangePolicy(policy, accountId);
    const canPropose =
        !!policy && !!accountId && isRequestor(policy, accountId);

    return {
        isLoading,
        canManage,
        canPropose,
        canAccess: canManage || canPropose,
    };
}
