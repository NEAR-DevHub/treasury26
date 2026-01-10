import { useMemo } from "react";
import { useTreasuryPolicy } from "./use-treasury-queries";

interface Member {
    accountId: string;
    roles: string[];
}

/**
 * Hook to extract and return unique members from treasury policy roles
 * @param treasuryId - The treasury ID to fetch members for
 * @returns Object containing members array and loading state
 */
export function useTreasuryMembers(treasuryId: string | null | undefined) {
    const { data: policy, isLoading } = useTreasuryPolicy(treasuryId);

    const members = useMemo(() => {
        if (!policy?.roles) return [];

        const memberMap = new Map<string, Set<string>>();

        // Iterate through each role and extract members
        for (const role of policy.roles) {
            if (typeof role.kind === "object" && "Group" in role.kind) {
                const accountIds = role.kind.Group;
                const roleName = role.name;

                for (const accountId of accountIds) {
                    let roles = memberMap.get(accountId);
                    if (!roles) {
                        roles = new Set();
                        memberMap.set(accountId, roles);
                    }
                    roles.add(roleName);
                }
            }
        }

        // Convert to array of Member objects and sort alphabetically
        return Array.from(memberMap, ([accountId, rolesSet]) => ({
            accountId,
            roles: Array.from(rolesSet),
        })).sort((a, b) =>
            a.accountId.toLowerCase().localeCompare(b.accountId.toLowerCase())
        );
    }, [policy]);

    return { members, isLoading };
}
