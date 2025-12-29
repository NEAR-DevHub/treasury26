import { useMemo, useState } from "react";
import { UseFormReturn } from "react-hook-form";
import { X } from "lucide-react";
import { Button } from "@/components/button";
import { Switch } from "@/components/ui/switch";
import { useNear } from "@/stores/near-store";
import { getApproversAndThreshold } from "@/lib/config-utils";

interface AddMemberFormData {
  members: Array<{
    accountId: string;
    selectedRoles: string[];
  }>;
  approveWithVote: boolean;
}

interface PreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  onBack: () => void;
  form: UseFormReturn<AddMemberFormData>;
  onSubmit: () => Promise<void>;
  policy: any;
}

export function PreviewModal({
  isOpen,
  onClose,
  onBack,
  form,
  onSubmit,
  policy,
}: PreviewModalProps) {
  const { accountId } = useNear();
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Check if user can vote on add_member_to_role proposals
  const { approverAccounts } = useMemo(() => {
    if (!policy || !accountId) return { approverAccounts: [] as string[] };
    return getApproversAndThreshold(policy, accountId, "add_member_to_role", false);
  }, [policy, accountId]);

  const canApprove = accountId && approverAccounts.includes(accountId);

  if (!isOpen) return null;

  const members = form.watch("members");
  const approveWithVote = form.watch("approveWithVote");

  const handleSubmit = async () => {
    setIsSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-3 border-b-2">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="text-muted-foreground hover:text-foreground transition-colors"
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M19 12H5M12 19l-7-7 7-7" />
              </svg>
            </button>
            <h2 className="text-xl font-semibold">Review Your Payment</h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {/* Summary Section with Background */}
          <div className="text-center py-8 bg-muted/50 rounded-lg">
            <p className="text-sm text-muted-foreground mb-2">
              You are adding
            </p>
            <h3 className="text-3xl font-bold">
              {members.length} new member
              {members.length !== 1 ? "s" : ""}
            </h3>
          </div>

          {/* New Members List */}
          <div>
            <h4 className="font-semibold pb-3">
              New Members
            </h4>
            <div className="space-y-0 rounded-lg overflow-hidden">
              {members.map((member, index) => (
                <div
                  key={index}
                  className={`flex items-center justify-between p-4 gap-4
                    border-b-2
                  `}
                >
                  <div className="flex items-center gap-3 min-w-0 flex-1">
                    <span className="flex items-center justify-center w-8 h-8 bg-muted rounded-full text-muted-foreground text-sm font-medium shrink-0">{index + 1}</span>
                    <span className="font-medium">{member.accountId}</span>
                  </div>
                  <div className="flex gap-2 flex-wrap">
                    {member.selectedRoles.map((role) => (
                      <span
                        key={role}
                        className="px-3 py-1 rounded-md bg-muted text-foreground text-sm font-medium"
                      >
                        {role}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Approve with vote section */}
          {canApprove && (
            <div className="pt-2">
              <label className="flex items-start gap-3 cursor-pointer">
                <Switch
                  checked={form.watch("approveWithVote")}
                  onCheckedChange={(checked) => form.setValue("approveWithVote", checked)}
                  className="mt-1"
                />
                <div className="flex-1">
                  <div className="font-medium">
                    Approve this request with my vote
                  </div>
                  <div className="text-sm text-muted-foreground">
                    This will count as the first approval for this member request.
                  </div>
                </div>
              </label>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="p-6 pt-0">
          <Button
            type="button"
            onClick={handleSubmit}
            className="w-full"
            disabled={isSubmitting}
          >
            {isSubmitting ? "Creating Proposal..." : "Confirm and Submit Request"}
          </Button>
        </div>
      </div>
    </div>
  );
}

