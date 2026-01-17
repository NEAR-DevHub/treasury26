import { useState } from "react";
import { UseFormReturn } from "react-hook-form";
import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RoleBadge } from "@/components/role-badge";

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
}

export function PreviewModal({
  isOpen,
  onClose,
  onBack,
  form,
  onSubmit,
  validationError,
}: PreviewModalProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const members = form.watch("members");

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
      <DialogContent className="sm:max-w-xl max-h-[90vh] gap-4">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <Button
              type="button"
              onClick={onBack}
              variant="ghost"
              size="icon-sm"
              className="shrink-0"
            >
              <ChevronLeft className="w-5 h-5" />
            </Button>
            <DialogTitle>Review Your Payment</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4 overflow-y-auto flex-1">
          {/* Summary Section with Background */}
          <div className="text-center py-8 bg-muted/50 rounded-lg">
            <p className="text-sm text-muted-foreground mb-2">You are adding</p>
            <h3 className="text-3xl font-bold">
              {members.length} new member
              {members.length !== 1 ? "s" : ""}
            </h3>
          </div>

          {/* New Members List */}
          <div>
            <h4 className="font-semibold pb-3">New Members</h4>
            <div className="space-y-0 rounded-lg overflow-hidden">
              {members.map((member, index) => (
                <div
                  key={index}
                  className={`flex items-center justify-between p-4 gap-4
                    border-b-2
                  `}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="flex items-center justify-center w-8 h-8 bg-muted rounded-full text-muted-foreground text-sm font-medium shrink-0">
                      {index + 1}
                    </span>
                    <span className="font-medium">{member.accountId}</span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {member.roles.map((role) => (
                      <RoleBadge key={role} role={role} variant="rounded" />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

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
      </DialogContent>
    </Dialog>
  );
}
