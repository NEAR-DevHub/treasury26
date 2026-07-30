"use client";

import { useTranslations } from "next-intl";
import { useCallback, useMemo } from "react";

interface Member {
    accountId: string;
    roles: string[];
}

interface ValidationResult {
    canModify: boolean;
    reason?: string;
}

interface ValidationOptions {
    accountId?: string;
    canAddMember?: boolean;
    hasPendingMemberRequest?: boolean;
}

export function useMemberValidation(
    members: Member[],
    options?: ValidationOptions,
) {
    const tAuth = useTranslations("auth");
    const tMembers = useTranslations("memberValidation");
    const { accountId, canAddMember, hasPendingMemberRequest } = options || {};

    const roleMembersMap = useMemo(() => {
        const map = new Map<string, Set<string>>();
        members.forEach((member) => {
            member.roles.forEach((role) => {
                if (!map.has(role)) {
                    map.set(role, new Set());
                }
                map.get(role)!.add(member.accountId);
            });
        });
        return map;
    }, [members]);

    const getRoleMemberCount = useCallback(
        (roleName: string): number => {
            return roleMembersMap.get(roleName)?.size || 0;
        },
        [roleMembersMap],
    );

    // Helper to format critical roles list - memoized function
    const formatRolesList = useCallback(
        (criticalRoles: string[]): string => {
            if (criticalRoles.length === 1) return criticalRoles[0];
            if (criticalRoles.length === 2)
                return tMembers("rolesAnd", {
                    first: criticalRoles[0],
                    second: criticalRoles[1],
                });
            return tMembers("rolesMany", {
                list: criticalRoles.slice(0, -1).join(", "),
                last: criticalRoles[criticalRoles.length - 1],
            });
        },
        [tMembers],
    );

    // Helper to check if roles contain governance - memoized
    const hasGovernanceRole = useCallback((roles: string[]): boolean => {
        return roles.some(
            (role) =>
                role.toLowerCase().includes("governance") ||
                role.toLowerCase().includes("admin"),
        );
    }, []);

    // Check permission/auth issues first - memoized result
    const permissionError = useMemo((): string | undefined => {
        if (!accountId) {
            return tAuth("noWallet");
        }
        if (!canAddMember) {
            return tMembers("noManagePermission");
        }
        if (hasPendingMemberRequest) {
            return tMembers("pendingRequest");
        }
        return undefined;
    }, [accountId, canAddMember, hasPendingMemberRequest, tAuth, tMembers]);

    // Check if modifying member roles would leave any role empty
    const canModifyMember = useCallback(
        (member: Member, newRoles?: string[]): ValidationResult => {
            // Check permission/auth first
            if (permissionError) {
                return {
                    canModify: false,
                    reason: permissionError,
                };
            }

            // For edit: always allow (user can add roles, specific role removal is handled in modal)
            if (newRoles !== undefined) {
                return { canModify: true };
            }

            // For delete: check if removing member would leave any role empty
            const rolesToCheck = member.roles;
            const criticalRoles: string[] = [];

            for (const roleName of rolesToCheck) {
                if (getRoleMemberCount(roleName) === 1) {
                    criticalRoles.push(roleName);
                }
            }

            if (criticalRoles.length > 0) {
                const hasGovernance = hasGovernanceRole(criticalRoles);
                const rolesList = formatRolesList(criticalRoles);
                const reason = hasGovernance
                    ? tMembers("cannotRemoveMemberGov", {
                          roles: rolesList,
                          count: criticalRoles.length,
                      })
                    : tMembers("cannotRemoveMember", {
                          roles: rolesList,
                          count: criticalRoles.length,
                      });

                return {
                    canModify: false,
                    reason,
                };
            }

            return { canModify: true };
        },
        [
            permissionError,
            getRoleMemberCount,
            hasGovernanceRole,
            formatRolesList,
            tMembers,
        ],
    );

    // Check if bulk delete is valid (check both permissions and role validation)
    const canDeleteBulk = useCallback(
        (membersToCheck: Member[]): ValidationResult => {
            // Check permission/auth first
            if (permissionError) {
                return {
                    canModify: false,
                    reason: permissionError,
                };
            }

            const accountIdsBeingRemoved = new Set(
                membersToCheck.map((m) => m.accountId),
            );

            // Check each role to see if it would be left empty
            const criticalRoles: string[] = [];

            // Only check roles that are present in members being removed
            const rolesToCheck = new Set<string>();
            membersToCheck.forEach((member) => {
                member.roles.forEach((role) => rolesToCheck.add(role));
            });

            for (const roleName of rolesToCheck) {
                const membersWithRole = roleMembersMap.get(roleName);
                if (!membersWithRole) continue;

                // Count remaining members (O(n) where n = members with this role, not all members)
                const remainingCount = Array.from(membersWithRole).filter(
                    (accountId) => !accountIdsBeingRemoved.has(accountId),
                ).length;

                if (remainingCount === 0) {
                    criticalRoles.push(roleName);
                }
            }

            if (criticalRoles.length > 0) {
                const hasGovernance = hasGovernanceRole(criticalRoles);
                const rolesList = formatRolesList(criticalRoles);
                const reason = hasGovernance
                    ? tMembers("cannotBulkRemoveGov", {
                          roles: rolesList,
                          count: criticalRoles.length,
                      })
                    : tMembers("cannotBulkRemove", {
                          roles: rolesList,
                          count: criticalRoles.length,
                      });

                return {
                    canModify: false,
                    reason,
                };
            }

            return { canModify: true };
        },
        [
            permissionError,
            roleMembersMap,
            hasGovernanceRole,
            formatRolesList,
            tMembers,
        ],
    );

    return {
        canModifyMember,
        canDeleteBulk,
    };
}
