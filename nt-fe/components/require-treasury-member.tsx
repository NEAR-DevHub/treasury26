"use client";

import { LoadingScreen } from "@/components/loading-screen";
import { NotMemberScreen } from "@/components/not-member-screen";
import { useTreasury } from "@/hooks/use-treasury";

/**
 * Blocks treasury shell UI for signed-in users who are not members of the
 * current treasury. Must sit inside `RequireAuth`.
 *
 * Pay share routes stay outside this wrapper — they remain publicly viewable.
 */
export function RequireTreasuryMember({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isLoading, isMember, treasuryNotFound } = useTreasury();

    if (isLoading) {
        return <LoadingScreen />;
    }

    if (!isMember || treasuryNotFound) {
        return <NotMemberScreen />;
    }

    return <>{children}</>;
}
