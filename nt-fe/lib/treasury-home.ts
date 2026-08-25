import type { Treasury } from "@/lib/api";

type MemberTreasury = Pick<Treasury, "daoId" | "isMember">;

function memberDaoIds(treasuries: ReadonlyArray<MemberTreasury>): string[] {
    return treasuries
        .filter((treasury) => treasury.isMember)
        .map((treasury) => treasury.daoId);
}

/**
 * Preferred member treasury for landing / home navigation.
 * Prefers `lastTreasuryId` when the user is still a member there.
 */
export function resolvePreferredMemberTreasuryId(
    treasuries: ReadonlyArray<MemberTreasury>,
    lastTreasuryId: string | null | undefined,
): string | null {
    const ids = memberDaoIds(treasuries);
    if (lastTreasuryId && ids.includes(lastTreasuryId)) {
        return lastTreasuryId;
    }
    return ids[0] ?? null;
}

/**
 * Destination for "Back to home" when the user isn't a member of the current
 * treasury: preferred member treasury, else the sign-in page.
 */
export function resolveTreasuryHomeHref(
    treasuries: ReadonlyArray<MemberTreasury>,
    lastTreasuryId: string | null | undefined,
): string {
    const daoId = resolvePreferredMemberTreasuryId(treasuries, lastTreasuryId);
    return daoId ? `/${daoId}` : "/login";
}
