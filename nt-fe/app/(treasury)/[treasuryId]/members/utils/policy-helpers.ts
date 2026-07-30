import type { Policy } from "@/types/policy";

export type MemberRoleChange = {
    member: string;
    roles: string[];
};

export type ExistingMember = {
    accountId: string;
    roles: string[];
};

/** Apply add/edit member role changes to a cloned policy. */
export function applyMemberRolesToPolicy(
    policy: Policy | undefined | null,
    membersList: MemberRoleChange[],
    existingMembers: ExistingMember[],
    isEdit: boolean = false,
) {
    if (!policy || !Array.isArray(policy.roles)) {
        return { updatedPolicy: policy, summary: "" };
    }

    const summaryLines = membersList
        .map(({ member, roles }) => {
            if (isEdit) {
                const currentMember = existingMembers.find(
                    (m) => m.accountId === member,
                );
                if (currentMember) {
                    const currentRoles = new Set(currentMember.roles);
                    const newRolesSet = new Set(roles);

                    const addedRoles = roles.filter(
                        (r) => !currentRoles.has(r),
                    );
                    const removedRoles = currentMember.roles.filter(
                        (r) => !newRolesSet.has(r),
                    );

                    const parts: string[] = [];
                    if (removedRoles.length > 0) {
                        parts.push(
                            `removed from [${removedRoles.map((r) => `"${r}"`).join(", ")}]`,
                        );
                    }
                    if (addedRoles.length > 0) {
                        parts.push(
                            `added to [${addedRoles.map((r) => `"${r}"`).join(", ")}]`,
                        );
                    }

                    if (parts.length > 0) {
                        return `- edit "${member}": ${parts.join(", ")}`;
                    }
                    return null;
                }
                return `- edit "${member}" to [${roles
                    .map((r) => `"${r}"`)
                    .join(", ")}]`;
            }
            return `- add "${member}" to [${roles.map((r) => `"${r}"`).join(", ")}]`;
        })
        .filter(Boolean);

    const updatedPolicy = structuredClone(policy);

    updatedPolicy.roles = updatedPolicy.roles.map((role) => {
        if (!(typeof role.kind === "object" && "Group" in role.kind)) {
            return role;
        }

        const roleName = role.name;
        let newGroup = [...(role.kind.Group || [])];

        membersList.forEach(({ member, roles }) => {
            const shouldHaveRole = roles.includes(roleName);
            const isInRole = newGroup.includes(member);

            if (shouldHaveRole && !isInRole) {
                newGroup.push(member);
            } else if (!shouldHaveRole && isInRole) {
                newGroup = newGroup.filter((m) => m !== member);
            }
        });

        role.kind.Group = newGroup;
        return role;
    });

    const summary = summaryLines.join("\n");
    return { updatedPolicy, summary };
}

export function removeMembersFromPolicy(
    policy: Policy | undefined | null,
    membersToRemove: MemberRoleChange[],
) {
    if (!policy || !Array.isArray(policy.roles)) {
        return { updatedPolicy: policy, summary: "" };
    }

    const summaryLines = membersToRemove.map(({ member, roles }) => {
        return `- remove "${member}" from [${roles
            .map((r) => `"${r}"`)
            .join(", ")}]`;
    });

    const memberIdsToRemove = membersToRemove.map((m) => m.member);
    const updatedPolicy = structuredClone(policy);

    updatedPolicy.roles.forEach((role) => {
        if (!(typeof role.kind === "object" && "Group" in role.kind)) {
            return;
        }
        role.kind.Group = (role.kind.Group || []).filter(
            (m: string) => !memberIdsToRemove.includes(m),
        );
    });

    const summary = summaryLines.join("\n");
    return { updatedPolicy, summary };
}
