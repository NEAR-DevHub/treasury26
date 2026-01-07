import { UseFormReturn, FormProvider } from "react-hook-form";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import { MemberInput } from "@/components/member-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RolePermission } from "@/types/policy";

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
  const title = isEditMode
    ? "Edit Roles"
    : "Add New Member";
  const buttonText = isValidatingAddresses
    ? isEditMode
      ? "Creating proposal..."
      : "Validating addresses..."
    : isEditMode
      ? "Confirm Changes"
      : "Review Request";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => !open && !isValidatingAddresses && onClose()}
    >
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col p-0 gap-4">
        <DialogHeader>
          <DialogTitle className="text-left">{title}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-6">
          <FormProvider {...form}>
            <MemberInput 
              control={form.control} 
              name="members"
              mode={mode}
              availableRoles={availableRoles.map(r => ({
                id: r.name,
                title: r.name,
              }))}
            />
          </FormProvider>
        </div>

        <div className="px-6 py-4 border-t border-border shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block">
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
      </DialogContent>
    </Dialog>
  );
}
