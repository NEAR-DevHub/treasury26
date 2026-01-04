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

export function useMemberValidation(members: Member[], options?: ValidationOptions) {
  const { accountId, canAddMember, hasPendingMemberRequest } = options || {};

  const roleMembersMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    members.forEach(member => {
      member.roles.forEach(role => {
        if (!map.has(role)) {
          map.set(role, new Set());
        }
        map.get(role)!.add(member.accountId);
      });
    });
    return map;
  }, [members]);

  // Pre-compute member to roles mapping for O(1) lookups
  const memberRolesMap = useMemo(() => {
    const map = new Map<string, Set<string>>();
    members.forEach(member => {
      map.set(member.accountId, new Set(member.roles));
    });
    return map;
  }, [members]);

  // Get count of members for each role (O(1) lookup)
  const getRoleMemberCount = useCallback((roleName: string): number => {
    return roleMembersMap.get(roleName)?.size || 0;
  }, [roleMembersMap]);

  // Helper to format critical roles list - memoized function
  const formatRolesList = useCallback((criticalRoles: string[]): string => {
    if (criticalRoles.length === 1) return criticalRoles[0];
    if (criticalRoles.length === 2) return `${criticalRoles[0]} and ${criticalRoles[1]}`;
    return `${criticalRoles.slice(0, -1).join(", ")}, and ${criticalRoles[criticalRoles.length - 1]}`;
  }, []);

  // Helper to check if roles contain governance - memoized
  const hasGovernanceRole = useCallback((roles: string[]): boolean => {
    return roles.some(role => 
      role.toLowerCase().includes("governance") || role.toLowerCase().includes("admin")
    );
  }, []);

  // Check permission/auth issues first - memoized result
  const permissionError = useMemo((): string | undefined => {
    if (!accountId) {
      return "Sign in required to manage members";
    }
    if (!canAddMember) {
      return "You don't have permission to manage members";
    }
    if (hasPendingMemberRequest) {
      return "You can't manage members while there is an active request";
    }
    return undefined;
  }, [accountId, canAddMember, hasPendingMemberRequest]);

  // Check if modifying member roles would leave any role empty
  const canModifyMember = useCallback((member: Member, newRoles?: string[]): ValidationResult => {
    // Check permission/auth first
    if (permissionError) {
      return {
        canModify: false,
        reason: permissionError,
      };
    }

    // If newRoles provided, check if removing member from their current roles
    // would leave those roles empty
    const rolesToCheck = newRoles 
      ? member.roles.filter(role => !newRoles.includes(role)) // Roles being removed
      : member.roles; // All roles (for deletion)

    const criticalRoles: string[] = [];
    
    for (const roleName of rolesToCheck) {
      if (getRoleMemberCount(roleName) === 1) {
        criticalRoles.push(roleName);
      }
    }
    
    if (criticalRoles.length > 0) {
      const hasGovernance = hasGovernanceRole(criticalRoles);
      const rolesList = formatRolesList(criticalRoles);
      const action = newRoles ? "modify" : "remove";
      const reason = hasGovernance
        ? `Cannot ${action} this member. They are the only person assigned to the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'}, which ${criticalRoles.length === 1 ? 'is' : 'are'} required to manage team members and configure voting.`
        : `Cannot ${action} this member. They are the only person assigned to the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'}.`;
      
      return {
        canModify: false,
        reason,
      };
    }
    
    return { canModify: true };
  }, [permissionError, getRoleMemberCount, hasGovernanceRole, formatRolesList]);

  // Check if bulk edit is allowed (only check permissions, not roles since we don't know new roles yet)
  const canEditBulk = useCallback((): ValidationResult => {
    if (permissionError) {
      return {
        canModify: false,
        reason: permissionError,
      };
    }
    return { canModify: true };
  }, [permissionError]);

  // Check if bulk delete is valid (check both permissions and role validation)
  const canDeleteBulk = useCallback((membersToCheck: Member[]): ValidationResult => {
    // Check permission/auth first
    if (permissionError) {
      return {
        canModify: false,
        reason: permissionError,
      };
    }

    const accountIdsBeingRemoved = new Set(membersToCheck.map(m => m.accountId));

    // Check each role to see if it would be left empty
    const criticalRoles: string[] = [];
    
    // Only check roles that are present in members being removed
    const rolesToCheck = new Set<string>();
    membersToCheck.forEach(member => {
      member.roles.forEach(role => rolesToCheck.add(role));
    });

    for (const roleName of rolesToCheck) {
      const membersWithRole = roleMembersMap.get(roleName);
      if (!membersWithRole) continue;

      // Count remaining members (O(n) where n = members with this role, not all members)
      const remainingCount = Array.from(membersWithRole).filter(
        accountId => !accountIdsBeingRemoved.has(accountId)
      ).length;
      
      if (remainingCount === 0) {
        criticalRoles.push(roleName);
      }
    }
    
    if (criticalRoles.length > 0) {
      const hasGovernance = hasGovernanceRole(criticalRoles);
      const rolesList = formatRolesList(criticalRoles);
      const reason = hasGovernance
        ? `Cannot remove these members. This would leave the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'} empty, which ${criticalRoles.length === 1 ? 'is' : 'are'} required to manage team members and configure voting.`
        : `Cannot remove these members. This would leave the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'} empty.`;
      
      return {
        canModify: false,
        reason,
      };
    }
    
    return { canModify: true };
  }, [permissionError, roleMembersMap, hasGovernanceRole, formatRolesList]);

  // Check if editing members with new roles would leave any role empty
  const canConfirmEdit = useCallback((edits: Array<{ accountId: string; oldRoles: string[]; newRoles: string[] }>): ValidationResult => {
    // Check permission/auth first
    if (permissionError) {
      return {
        canModify: false,
        reason: permissionError,
      };
    }

    const editMap = new Map(edits.map(e => [e.accountId, e.newRoles]));

    // Check each role to see if it would be empty after edits
    const criticalRoles: string[] = [];

    for (const [roleName, membersWithRole] of roleMembersMap) {
      let remainingCount = 0;
      
      // For each member with this role, check if they still have it after edits
      for (const accountId of membersWithRole) {
        const newRoles = editMap.get(accountId);
        
        if (newRoles !== undefined) {
          // This member is being edited - check new roles
          if (newRoles.includes(roleName)) {
            remainingCount++;
          }
        } else {
          // This member is not being edited - they still have the role
          remainingCount++;
        }
      }
      
      if (remainingCount === 0) {
        criticalRoles.push(roleName);
      }
    }

    if (criticalRoles.length > 0) {
      const hasGovernance = hasGovernanceRole(criticalRoles);
      const rolesList = formatRolesList(criticalRoles);
      const reason = hasGovernance
        ? `Cannot save these changes. This would leave the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'} empty, which ${criticalRoles.length === 1 ? 'is' : 'are'} required to manage team members and configure voting.`
        : `Cannot save these changes. This would leave the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'} empty.`;
      
      return {
        canModify: false,
        reason,
      };
    }

    return { canModify: true };
  }, [permissionError, roleMembersMap, hasGovernanceRole, formatRolesList]);

  // Check if adding new member is allowed
  const canAddNewMember = useCallback((): ValidationResult => {
    if (permissionError) {
      return {
        canModify: false,
        reason: permissionError,
      };
    }
    return { canModify: true };
  }, [permissionError]);

  return {
    canModifyMember,
    canEditBulk,
    canDeleteBulk,
    canConfirmEdit,
    canAddNewMember,
    getRoleMemberCount,
  };
}

