import { useState, useEffect } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/button";
import { RolePermission } from "@/types/policy";

interface Member {
  accountId: string;
  roles: string[];
}

interface EditRolesModalProps {
  isOpen: boolean;
  onClose: () => void;
  member: Member | null;
  availableRoles: RolePermission[];
  isOnlyMemberWithRole: (member: Member, roleName: string) => boolean;
  onSubmit: (memberAccountId: string, newRoles: string[]) => Promise<void>;
}

export function EditRolesModal({
  isOpen,
  onClose,
  member,
  availableRoles,
  isOnlyMemberWithRole,
  onSubmit,
}: EditRolesModalProps) {
  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(new Set());
  const [initialRoles, setInitialRoles] = useState<Set<string>>(new Set());
  const [hoveredRole, setHoveredRole] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Initialize selected roles when member or isOpen changes
  useEffect(() => {
    if (member && isOpen) {
      const roles = new Set(member.roles);
      setSelectedRoles(roles);
      setInitialRoles(roles);
    }
  }, [member, isOpen]);

  if (!isOpen || !member) return null;

  const handleToggleRole = (roleName: string) => {
    // Check if this role is disabled (member is only one with this role)
    if (isOnlyMemberWithRole(member, roleName)) {
      return; // Don't allow toggling
    }
    
    setSelectedRoles((prev) => {
      const newRoles = new Set(prev);
      if (newRoles.has(roleName)) {
        newRoles.delete(roleName);
      } else {
        newRoles.add(roleName);
      }
      return newRoles;
    });
  };

  // Check if there are any changes
  const hasChanges = () => {
    if (selectedRoles.size !== initialRoles.size) return true;
    for (const role of selectedRoles) {
      if (!initialRoles.has(role)) return true;
    }
    return false;
  };

  const handleSubmit = async () => {
    if (!member) return;
    
    setIsSubmitting(true);
    try {
      const newRolesArray = Array.from(selectedRoles);
      await onSubmit(member.accountId, newRolesArray);
      onClose();
    } catch (error) {
      // Error is already handled in parent
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-lg shadow-xl max-w-2xl w-full">
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-3 border-b-2">
          <h2 className="text-xl font-semibold">Edit Roles</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}    
          {/* Roles List with Background */}
          <div className="px-6 py-2">
            {availableRoles.map((role) => {
              const isOnlyOne = isOnlyMemberWithRole(member, role.name);
              const isDisabled = isOnlyOne && selectedRoles.has(role.name);
              
              return (
                <div key={role.name} className="relative">
                  <label
                    className={`flex items-start gap-3 py-3 rounded-lg transition-colors ${
                      isDisabled 
                        ? "cursor-not-allowed opacity-60" 
                        : "cursor-pointer hover:bg-card/50"
                    }`}
                    onMouseEnter={() => isDisabled && setHoveredRole(role.name)}
                    onMouseLeave={() => setHoveredRole(null)}
                  >
                    <input
                      type="checkbox"
                      checked={selectedRoles.has(role.name)}
                      onChange={() => handleToggleRole(role.name)}
                      disabled={isDisabled}
                      className="mt-1 w-5 h-5 rounded border-input accent-primary focus:ring-primary disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <div className="flex-1">
                      <div className="font-semibold text-base">{role.name}</div>
                    </div>
                  </label>
                  {hoveredRole === role.name && isDisabled && (
                    <div className="absolute left-0 top-full mt-2 w-full p-3 bg-foreground text-background text-sm rounded-lg shadow-xl z-50">
                      {role.name.toLowerCase().includes("governance") || role.name.toLowerCase().includes("admin")
                        ? `Cannot remove the ${role.name} role from this member. They are the only person assigned to this role, which is required to manage team members and configure voting.`
                        : `Cannot remove the ${role.name} role from this member. They are the only person assigned to this role.`}
                      <div className="absolute bottom-full left-8 -mb-1">
                        <div className="border-8 border-transparent border-b-foreground"></div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

        {/* Footer */}
        <div className="p-6 pt-0">
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={!hasChanges() || isSubmitting}
            className="w-full"
          >
            {isSubmitting ? "Creating Proposal..." : "Create Request"}
          </Button>
        </div>
      </div>
    </div>
  );
}

