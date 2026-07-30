import type { RolePermission } from "@/types/policy";
import { NEARN_IO_ACCOUNT } from "../constants";
import type { ExistingMember } from "./policy-helpers";

type FormMember = {
    accountId: string;
    roles: string[];
};

type DisabledRole = {
    roleId: string;
    reason: string;
};

type Messages = {
    requestorOnlyTooltip: string;
    cannotRemoveRoleAfter: (role: string) => string;
    cannotRemoveRoleAfterGov: (role: string) => string;
};

/**
 * Roles that cannot be toggled off for a member during edit
 * (NEARN requestor lock + last-member-in-role protection).
 */
export function getDisabledRolesForMemberEdit(
    accountId: string,
    currentRoles: string[],
    membersInForm: FormMember[],
    existingMembers: ExistingMember[],
    availableRoles: RolePermission[],
    messages: Messages,
): DisabledRole[] {
    const disabledRoles: DisabledRole[] = [];

    const isNearnIoAccount =
        accountId.toLowerCase() === NEARN_IO_ACCOUNT.toLowerCase();

    if (isNearnIoAccount) {
        const rolesWithAddProposal = availableRoles.filter((role) =>
            role.permissions.some((perm) => perm.includes(":AddProposal")),
        );

        const rolesWithFullWildcard =
            rolesWithAddProposal.length === 0
                ? availableRoles.filter((role) =>
                      role.permissions.some((perm) => perm === ":*"),
                  )
                : [];

        const allowedRoles =
            rolesWithAddProposal.length > 0
                ? rolesWithAddProposal
                : rolesWithFullWildcard;

        availableRoles.forEach((role) => {
            const isAllowed = allowedRoles.some(
                (allowedRole) => allowedRole.name === role.name,
            );

            if (!isAllowed) {
                disabledRoles.push({
                    roleId: role.name,
                    reason: messages.requestorOnlyTooltip,
                });
            }
        });

        return disabledRoles;
    }

    const isEditMode = existingMembers.some((m) => m.accountId === accountId);
    if (!isEditMode) {
        return disabledRoles;
    }

    const finalRoleMembersMap = new Map<string, Set<string>>();

    existingMembers.forEach((member) => {
        member.roles.forEach((role) => {
            if (!finalRoleMembersMap.has(role)) {
                finalRoleMembersMap.set(role, new Set());
            }
            finalRoleMembersMap.get(role)!.add(member.accountId);
        });
    });

    membersInForm.forEach((formMember) => {
        const memberId = formMember.accountId;
        const newRoles = formMember.roles || [];

        const originalMember = existingMembers.find(
            (m) => m.accountId === memberId,
        );
        if (!originalMember) return;

        originalMember.roles.forEach((role) => {
            if (!newRoles.includes(role)) {
                finalRoleMembersMap.get(role)?.delete(memberId);
            }
        });

        newRoles.forEach((role) => {
            if (!finalRoleMembersMap.has(role)) {
                finalRoleMembersMap.set(role, new Set());
            }
            finalRoleMembersMap.get(role)!.add(memberId);
        });
    });

    currentRoles.forEach((role) => {
        const membersWithRoleAfterEdits = finalRoleMembersMap.get(role);

        if (
            membersWithRoleAfterEdits &&
            membersWithRoleAfterEdits.size === 1 &&
            membersWithRoleAfterEdits.has(accountId)
        ) {
            const hasGovernance =
                role.toLowerCase().includes("governance") ||
                role.toLowerCase().includes("admin");

            disabledRoles.push({
                roleId: role,
                reason: hasGovernance
                    ? messages.cannotRemoveRoleAfterGov(role)
                    : messages.cannotRemoveRoleAfter(role),
            });
        }
    });

    return disabledRoles;
}
