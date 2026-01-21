import { ROLES } from "@/components/role-selector";

/**
 * Sort roles in the correct order (Governance, Requestor, Financial)
 * Roles not in the ROLES constant are placed at the end
 */
export function sortRolesByOrder(roles: string[]): string[] {
  const roleOrder = ROLES.map(r => r.id.toLowerCase());
  return [...roles].sort((a, b) => {
    const indexA = roleOrder.indexOf(getRoleIdForSorting(a));
    const indexB = roleOrder.indexOf(getRoleIdForSorting(b));
    // If role not found in ROLES, put it at the end
    if (indexA === -1) return 1;
    if (indexB === -1) return -1;
    return indexA - indexB;
  });
}

/**
 * Map old policy role names to new ROLES constant IDs for getting descriptions
 * Admin -> Governance
 * Approver -> Financial
 */
function getRoleIdForSorting(roleName: string): string {
  const normalized = roleName.toLowerCase();
  
  // Map old names to new names
  if (normalized === "admin") return "governance";
  if (normalized === "approver") return "financial";
  
  return normalized;
}

/**
 * Get role description from ROLES constant, handling name mapping
 * Always uses the new role names (Governance, Financial) in descriptions
 */
export function getRoleDescription(roleName: string): string | undefined {
  const roleId = getRoleIdForSorting(roleName);
  const roleInfo = ROLES.find(r => r.id === roleId);
  
  if (!roleInfo?.description) return undefined;
  
  return roleInfo.description;
}

