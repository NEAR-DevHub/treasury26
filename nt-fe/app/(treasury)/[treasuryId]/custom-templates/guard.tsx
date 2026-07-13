"use client";

/**
 * Route-level guard for the Request Templates subtree (index, create, [slug], edit).
 *
 * Closes the view-level gaps the sidebar-only check left open, mirroring the nt-be gates:
 *  - #1026: direct URL while Custom Requests is disabled in Settings → Developer.
 *  - #1027: guests / signed-out / non-member viewers reaching the create/authoring UI.
 *  - list/authoring visibility (#1046): anyone who can author (`AddProposal` — Requestors, incl.
 *    transfer-only, and admins) or file (`canPropose`) may see the list; only authors reach
 *    create/edit (`requireAuthor`). Note authoring (`AddProposal`) is broader than filing a template
 *    request (`call:AddProposal`) — a transfer-only requestor can author but not file. Delete is
 *    admin-only and is a dialog on the index, not a route, so it isn't guarded here.
 *
 * The feature flag already narrows to a signed-in member of a non-guest treasury; on top of that we
 * require `canAccess` (`canAuthor || canPropose`). Writes stay enforced server-side; this aligns the
 * UI so no one lands on a page they can't act on.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingScreen } from "@/components/loading-screen";
import { useCustomRequestsEnabled } from "@/features/proposal-templates/hooks/use-custom-requests-enabled";
import { useCustomTemplatesAccess } from "@/features/proposal-templates/hooks/use-custom-templates-access";
import { useTreasury } from "@/hooks/use-treasury";

export function CustomTemplatesGuard({
    children,
    requireAuthor = false,
}: {
    children: React.ReactNode;
    /** Also require authoring (create/edit) permission — for the create/edit pages. */
    requireAuthor?: boolean;
}) {
    const router = useRouter();
    const { treasuryId, isLoading: treasuryLoading } = useTreasury();
    // A disabled flag query reports isLoading=false with data=undefined, so a falsy `enabled` once
    // everything settled means "not allowed here" — covering feature-off and every non-member case.
    const { data: enabled, isLoading: flagLoading } =
        useCustomRequestsEnabled();
    const {
        canAccess,
        canAuthor,
        isAdmin,
        isLoading: accessLoading,
    } = useCustomTemplatesAccess();

    const settled = !treasuryLoading && !flagLoading && !accessLoading;
    // May view the subtree at all (feature on + canAccess, i.e. canAuthor || canPropose).
    const canView = !!enabled && canAccess;
    const allowed = canView && (!requireAuthor || canAuthor);

    useEffect(() => {
        if (!settled || allowed || !treasuryId) {
            return;
        }
        // Send each blocked persona somewhere it can actually act:
        //  - a viewer who somehow lacks authoring on create/edit → the list they *can* use;
        //  - an admin who finds the feature disabled → the Developer toggle to re-enable it;
        //  - anyone without access (guest / signed-out / non-member) → the treasury dashboard,
        //    not a Settings tab that is itself hidden from them.
        let target = `/${treasuryId}/dashboard`;
        if (canView && requireAuthor) {
            target = `/${treasuryId}/custom-templates`;
        } else if (isAdmin) {
            target = `/${treasuryId}/settings?tab=developer`;
        }
        router.replace(target);
    }, [settled, allowed, canView, isAdmin, requireAuthor, treasuryId, router]);

    // Hold the loading screen until access is known — never flash protected content, nor the
    // create/edit form for a blocked viewer during the redirect frame.
    if (!settled || !allowed) {
        return <LoadingScreen />;
    }
    return <>{children}</>;
}
