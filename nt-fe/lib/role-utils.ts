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
 * Map policy role names to ROLES constant IDs for getting descriptions
 * Admin -> governance, Approver -> financial, etc.
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
 * Also replaces the ROLES constant name with the actual role name in the description
 * E.g., "Governance can..." becomes "Admin can..." when roleName is "Admin"
 */
export function getRoleDescription(roleName: string): string | undefined {
  const roleId = getRoleIdForSorting(roleName);
  const roleInfo = ROLES.find(r => r.id === roleId);
  
  if (!roleInfo?.description) return undefined;
  
  // Replace the ROLES constant title with the actual role name
  // E.g., "Governance can..." -> "Admin can..." when roleName is "Admin"
  return roleInfo.description.replace(roleInfo.title, roleName);
}

