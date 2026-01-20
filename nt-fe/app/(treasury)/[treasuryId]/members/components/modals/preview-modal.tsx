import { useState } from "react";
import { UseFormReturn } from "react-hook-form";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/modal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RoleBadge } from "@/components/role-badge";
import { sortRolesByOrder } from "@/lib/role-utils";

interface AddMemberFormData {
  members: Array<{
    accountId: string;
    roles: string[];
  }>;
}

interface PreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBack: () => void;
  form: UseFormReturn<AddMemberFormData>;
  onSubmit: () => Promise<void>;
  validationError?: string;
  mode?: "add" | "edit";
  existingMembers?: Array<{
    accountId: string;
    roles: string[];
  }>;
}

export function PreviewModal({
  isOpen,
  onClose,
  onBack,
  form,
  onSubmit,
  validationError,
  mode = "add",
  existingMembers = [],
}: PreviewModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const members = form.watch("members");
  const isEditMode = mode === "edit";

  // Filter members to only show those with actual changes in edit mode
  const membersToShow = isEditMode
    ? members.filter((member) => {
        const existingMember = existingMembers.find(
          (m) => m.accountId === member.accountId
        );
        if (!existingMember) return false;

        // Check if roles have changed
        const currentRolesSorted = sortRolesByOrder([...member.roles]).join(
          ","
        );
        const existingRolesSorted = sortRolesByOrder([
          ...existingMember.roles,
        ]).join(",");

        return currentRolesSorted !== existingRolesSorted;
      })
    : members;

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] flex flex-col gap-4">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div onClick={onBack}>
              <ChevronLeft className="w-5 h-5" />
            </div>
            <DialogTitle>Review Your Request</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1">
          {/* Summary Section with Background */}
          <div className="text-center py-8 bg-muted/50 rounded-lg">
            {isEditMode ? (
              <>
                <p className="text-sm text-muted-foreground mb-2">
                  You are editing
                </p>
                <h3 className="text-3xl font-bold">
                  {membersToShow.length} member
                  {membersToShow.length !== 1 ? "s" : ""}
                </h3>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground mb-2">
                  You are adding
                </p>
                <h3 className="text-3xl font-bold">
                  {membersToShow.length} new member
                  {membersToShow.length !== 1 ? "s" : ""}
                </h3>
              </>
            )}
          </div>

          {/* Members List */}
          <div>
            <h4 className="font-semibold pb-3">
              {isEditMode ? "Updated Members" : "New Members"}
            </h4>
            <div className="space-y-0 rounded-lg overflow-hidden">
              {membersToShow.map((member, index) => (
                <div
                  key={isEditMode ? member.accountId : index}
                  className="flex items-center justify-between p-4 px-0 gap-4 border-b-2"
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="flex items-center justify-center w-8 h-8 bg-muted rounded-full text-muted-foreground text-sm font-medium shrink-0">
                      {index + 1}
                    </span>
                    <span className="font-medium break-all">
                      {member.accountId}
                    </span>
                  </div>
                  <div className="flex gap-2 flex-wrap shrink-0">
                    {sortRolesByOrder(member.roles).map((role) => (
                      <RoleBadge key={role} role={role} variant="rounded" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <div className="w-full">
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="block">
                  <Button
                    type="button"
                    onClick={handleSubmit}
                    className="w-full"
                    disabled={isSubmitting || !!validationError}
                  >
                    {isSubmitting
                      ? "Creating Proposal..."
                      : "Confirm and Submit Request"}
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
