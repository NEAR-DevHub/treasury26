import { UseFormReturn, FormProvider } from "react-hook-form";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/modal";
import { MemberInput } from "@/components/member-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RolePermission } from "@/types/policy";
import { getRoleDescription, sortRolesByOrder } from "@/lib/role-utils";

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
}: MemberModalProps) {
  const isEditMode = mode === "edit";
  const title = isEditMode ? "Edit Roles" : "Add New Member";
  const buttonText = isValidatingAddresses
    ? isEditMode
      ? "Creating proposal..."
      : "Validating addresses..."
    : "Review Request";

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
                  title: r.name, // Keep original role name (Admin, Approver, etc.)
                  description: getRoleDescription(r.name),
                }));

                // Sort by the role names to maintain order: Admin/Governance, Requestor, Approver/Financial
                const roleNames = mappedRoles.map((r) => r.id);
                const sortedNames = sortRolesByOrder(roleNames);

                return sortedNames.map(
                  (name) => mappedRoles.find((r) => r.id === name)!
                );
              })()}
            />
          </FormProvider>
        </div>

        <DialogFooter>
          <div className="w-full">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block w-full">
                  <Button
                    type="button"
                    onClick={onReviewRequest}
                    disabled={
                      !form.formState.isValid ||
                      isValidatingAddresses ||
                      !!validationError
                    }
                    className="w-full"
                  >
                    {buttonText}
                  </Button>
                </span>
              </TooltipTrigger>
              {validationError && (
                <TooltipContent className="max-w-[280px]">
                  <p>{validationError}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
