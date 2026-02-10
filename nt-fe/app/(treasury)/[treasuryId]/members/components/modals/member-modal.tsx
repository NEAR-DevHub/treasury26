import { UseFormReturn, FormProvider } from "react-hook-form";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/modal";
import { MemberInput } from "@/components/member-input";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { RolePermission } from "@/types/policy";
import { getRoleDescription, sortRolesByOrder } from "@/lib/role-utils";
import { formatRoleName } from "@/components/role-name";

interface MemberFormData {
  members: Array<{
    accountId: string;
    roles: string[];
  }>;
}

interface MemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  form: UseFormReturn<MemberFormData>;
  availableRoles: RolePermission[];
  onReviewRequest: () => void;
  isValidatingAddresses: boolean;
  mode: "add" | "edit";
  validationError?: string;
  originalMembers?: Array<{
    accountId: string;
    roles: string[];
  }>;
  getDisabledRoles?: (accountId: string, currentRoles: string[]) => { roleId: string; reason: string }[];
}

export function MemberModal({
  isOpen,
  onClose,
  form,
  availableRoles,
  onReviewRequest,
  isValidatingAddresses,
  mode,
  validationError,
  originalMembers,
  getDisabledRoles,
}: MemberModalProps) {
  const isEditMode = mode === "edit";
  const title = isEditMode ? "Edit Roles" : "Add New Member";
  const buttonText = isValidatingAddresses
    ? isEditMode
      ? "Creating proposal..."
      : "Validating addresses..."
    : "Review Request";

  // Check if any changes have been made in edit mode
  const hasChanges = (() => {
    if (!isEditMode || !originalMembers) return true;

    const currentMembers = form.watch("members");

    // Compare each member's roles with original
    return currentMembers.some((currentMember) => {
      const originalMember = originalMembers.find(
        (m) => m.accountId === currentMember.accountId
      );
      if (!originalMember) return true;

      // Sort roles for comparison
      const currentRolesSorted = [...currentMember.roles].sort();
      const originalRolesSorted = [...originalMember.roles].sort();

      // Check if roles are different
      return (
        currentRolesSorted.length !== originalRolesSorted.length ||
        currentRolesSorted.some(
          (role, index) => role !== originalRolesSorted[index]
        )
      );
    });
  })();

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => !open && !isValidatingAddresses && onClose()}
    >
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col gap-4">
        <DialogHeader>
          <DialogTitle className="text-left">{title}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1">
          <FormProvider {...form}>
            <MemberInput
              control={form.control}
              name="members"
              mode={mode}
              availableRoles={(() => {
                // Map roles and sort them in correct order
                const mappedRoles = availableRoles.map((r) => ({
                  id: r.name,
                  title: formatRoleName(r.name), // Convert old names (Admin, Approver) to new names (Governance, Financial)
                  description: getRoleDescription(r.name),
                }));

                // Sort by the role names to maintain order: Governance, Requestor, Financial
                const roleNames = mappedRoles.map((r) => r.id);
                const sortedNames = sortRolesByOrder(roleNames);

                return sortedNames.map(
                  (name) => mappedRoles.find((r) => r.id === name)!
                );
              })()}
              getDisabledRoles={getDisabledRoles}
            />
          </FormProvider>
        </div>

        <DialogFooter>
          <div className="w-full">
            <ButtonWithTooltip
              type="button"
              onClick={onReviewRequest}
              disabled={
                !form.formState.isValid ||
                isValidatingAddresses ||
                !!validationError ||
                (isEditMode && !hasChanges)
              }
              className="w-full"
              tooltipMessage={
                validationError ||
                (isEditMode && !hasChanges
                  ? "No changes have been made to member roles"
                  : undefined)
              }
            >
              {buttonText}
            </ButtonWithTooltip>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
