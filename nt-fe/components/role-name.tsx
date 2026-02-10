/**
 * Maps internal role names to display names
 * Approver -> Financial
 * Admin -> Governance
 */
export function formatRoleName(roleName: string): string {
    if (roleName === "Approver") return "Financial";
    if (roleName === "Admin") return "Governance";
    return roleName;
}

interface RoleNameProps {
    name: string;
    className?: string;
}

/**
 * Component to display a formatted role name
 */
export function RoleName({ name, className }: RoleNameProps) {
    return <span className={className}>{formatRoleName(name)}</span>;
}
