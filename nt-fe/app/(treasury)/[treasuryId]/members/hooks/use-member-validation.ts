import { useMemo, useCallback } from "react";

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
  options?: ValidationOptions
) {
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
    [roleMembersMap]
  );

  // Helper to format critical roles list - memoized function
  const formatRolesList = useCallback((criticalRoles: string[]): string => {
    if (criticalRoles.length === 1) return criticalRoles[0];
    if (criticalRoles.length === 2)
      return `${criticalRoles[0]} and ${criticalRoles[1]}`;
    return `${criticalRoles.slice(0, -1).join(", ")}, and ${criticalRoles[criticalRoles.length - 1]
      }`;
  }, []);

  // Helper to check if roles contain governance - memoized
  const hasGovernanceRole = useCallback((roles: string[]): boolean => {
    return roles.some(
      (role) =>
        role.toLowerCase().includes("governance") ||
        role.toLowerCase().includes("admin")
    );
  }, []);

  // Check permission/auth issues first - memoized result
  const permissionError = useMemo((): string | undefined => {
    if (!accountId) {
      return "Connect your wallet";
    }
    if (!canAddMember) {
      return "You don’t have permission to manage members";
    }
    if (hasPendingMemberRequest) {
      return "You can't manage members while there is an active request";
    }
    return undefined;
  }, [accountId, canAddMember, hasPendingMemberRequest]);

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
          ? `Cannot remove this member. They are the only person assigned to the ${rolesList} ${criticalRoles.length === 1 ? "role" : "roles"
          }, which ${criticalRoles.length === 1 ? "is" : "are"
          } required to manage team members and configure voting.`
          : `Cannot remove this member. They are the only person assigned to the ${rolesList} ${criticalRoles.length === 1 ? "role" : "roles"
          }.`;

        return {
          canModify: false,
          reason,
        };
      }

      return { canModify: true };
    },
    [permissionError, getRoleMemberCount, hasGovernanceRole, formatRolesList]
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
        membersToCheck.map((m) => m.accountId)
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
          (accountId) => !accountIdsBeingRemoved.has(accountId)
        ).length;

        if (remainingCount === 0) {
          criticalRoles.push(roleName);
        }
      }

      if (criticalRoles.length > 0) {
        const hasGovernance = hasGovernanceRole(criticalRoles);
        const rolesList = formatRolesList(criticalRoles);
        const reason = hasGovernance
          ? `Cannot remove these members. This would leave the ${rolesList} ${criticalRoles.length === 1 ? "role" : "roles"
          } empty, which ${criticalRoles.length === 1 ? "is" : "are"
          } required to manage team members and configure voting.`
          : `Cannot remove these members. This would leave the ${rolesList} ${criticalRoles.length === 1 ? "role" : "roles"
          } empty.`;

        return {
          canModify: false,
          reason,
        };
      }

      return { canModify: true };
    },
    [permissionError, roleMembersMap, hasGovernanceRole, formatRolesList]
  );

  // Check if a single role change for a member would leave any role empty
  // This is used for inline validation in the edit modal
  const canRemoveRoleFromMember = useCallback(
    (accountId: string, roleToRemove: string): ValidationResult => {
      // Check if removing this role would leave it empty
      const membersWithRole = roleMembersMap.get(roleToRemove);
      if (!membersWithRole) return { canModify: true };

      // If this member has the role and is the only one, prevent removal
      if (membersWithRole.size === 1 && membersWithRole.has(accountId)) {
        const hasGovernance = hasGovernanceRole([roleToRemove]);
        const reason = hasGovernance
          ? `You can't remove the ${roleToRemove} role from this member. They are the only ${roleToRemove} member, and without this role you won't be able to manage team members or configure voting.`
          : `You can't remove the ${roleToRemove} role from this member. They are the only person assigned to this role.`;

        return {
          canModify: false,
          reason,
        };
      }

      return { canModify: true };
    },
    [roleMembersMap, hasGovernanceRole]
  );

  return {
    canModifyMember,
    canDeleteBulk,
    getRoleMemberCount,
    canRemoveRoleFromMember,
  };
}
