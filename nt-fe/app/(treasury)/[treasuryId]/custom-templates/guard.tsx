"use client";

/**
 * Route-level guard for the Request Templates subtree (index, create, [slug], edit).
 *
 * Closes the view-level gaps the sidebar-only check left open, mirroring the nt-be gates:
 *  - #1026: direct URL while Custom Requests is disabled in Settings → Developer.
 *  - #1027: guests / signed-out / non-member viewers reaching the create/authoring UI.
 *  - list/authoring visibility: only Requestors (can propose) and policy managers (can author) may
 *    see the list; only managers may reach create/edit (`requireManage`).
 *
 * The feature flag already narrows to a signed-in member of a non-guest treasury; on top of that we
 * require `canAccess` (propose or manage). Writes were always safe (ChangePolicy-gated server-side);
 * this aligns the UI so no one lands on a page they can't act on.
 */
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { LoadingScreen } from "@/components/loading-screen";
import { useCustomRequestsEnabled } from "@/features/proposal-templates/hooks/use-custom-requests-enabled";
import { useCustomTemplatesAccess } from "@/features/proposal-templates/hooks/use-custom-templates-access";
import { useTreasury } from "@/hooks/use-treasury";

export function CustomTemplatesGuard({
    children,
    requireManage = false,
}: {
    children: React.ReactNode;
    /** Also require authoring (ChangePolicy) permission — for the create/edit pages. */
    requireManage?: boolean;
}) {
    const router = useRouter();
    const { treasuryId, isLoading: treasuryLoading } = useTreasury();
    // A disabled flag query reports isLoading=false with data=undefined, so a falsy `enabled` once
    // everything settled means "not allowed here" — covering feature-off and every non-member case.
    const { data: enabled, isLoading: flagLoading } =
        useCustomRequestsEnabled();
    const {
        canAccess,
        canManage,
        isLoading: accessLoading,
    } = useCustomTemplatesAccess();

    const settled = !treasuryLoading && !flagLoading && !accessLoading;
    // May view the subtree at all (feature on + can propose or manage).
    const canView = !!enabled && canAccess;
    const allowed = canView && (!requireManage || canManage);

    useEffect(() => {
        if (!settled || allowed || !treasuryId) {
            return;
        }
        // Send each blocked persona somewhere it can actually act:
        //  - a proposer who hit create/edit → the list they *can* use;
        //  - a manager who finds the feature disabled → the Developer toggle to re-enable it;
        //  - anyone without access (guest / signed-out / non-member) → the treasury dashboard,
        //    not a Settings tab that is itself hidden from them.
        let target = `/${treasuryId}/dashboard`;
        if (canView && requireManage) {
            target = `/${treasuryId}/custom-templates`;
        } else if (canManage) {
            target = `/${treasuryId}/settings?tab=developer`;
        }
        router.replace(target);
    }, [
        settled,
        allowed,
        canView,
        canManage,
        requireManage,
        treasuryId,
        router,
    ]);

    // Hold the loading screen until access is known — never flash protected content, nor the
    // create/edit form for a proposer during the redirect frame.
    if (!settled || !allowed) {
        return <LoadingScreen />;
    }
    return <>{children}</>;
}
