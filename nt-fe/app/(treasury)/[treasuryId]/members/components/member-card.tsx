import { Trash2 } from "lucide-react";
import { User } from "@/components/user";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

interface Member {
  accountId: string;
  roles: string[];
}

interface MemberCardProps {
  member: Member;
  onEdit: (member: Member) => void;
  onDelete: (member: Member) => void;
  canDeleteMember: (member: Member) => { canDelete: boolean; reason?: string };
  hasPendingRequest: boolean;
  hasPermission: boolean;
  accountId: string | null;
}

export function MemberCard({
  member,
  onEdit,
  onDelete,
  canDeleteMember,
  hasPendingRequest,
  hasPermission,
  accountId,
}: MemberCardProps) {
  const deleteStatus = canDeleteMember(member);
  const isDisabled = hasPendingRequest || !deleteStatus.canDelete || !accountId || !hasPermission;
  const isEditDisabled = hasPendingRequest || !accountId || !hasPermission;

  const deleteTooltipMessage = !accountId
    ? "Sign in required"
    : !hasPermission
    ? "You don't have permission to manage members"
    : hasPendingRequest
    ? "You can't add, edit, or remove members while there is an active request. Please approve or reject the current request first."
    : deleteStatus.reason;

  const editTooltipMessage = !accountId
    ? "Sign in required"
    : !hasPermission
    ? "You don't have permission to manage members"
    : hasPendingRequest
    ? "You can't add, edit, or remove members while there is an active request. Please approve or reject the current request first."
    : undefined;

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4 flex flex-col">
      {/* Member Header */}
      <User accountId={member.accountId} size="lg" withLink={false} />

      {/* Role Badges */}
      <div className="flex flex-wrap gap-2">
        {member.roles.map((role) => (
          <span
            key={role}
            className="px-3 py-1 rounded-md bg-muted text-foreground text-sm font-medium"
          >
            {role}
          </span>
        ))}
      </div>

      {/* Action Buttons */}
      <div className="flex items-center justify-end gap-3 pt-3 mt-auto">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              disabled={isDisabled}
              onClick={() => {
                if (!isDisabled) {
                  onDelete(member);
                }
              }}
              className={`transition-colors ${
                !isDisabled
                  ? "text-destructive hover:text-destructive/80"
                  : "text-destructive/40 cursor-not-allowed"
              }`}
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </TooltipTrigger>
          {isDisabled && deleteTooltipMessage && (
            <TooltipContent side="top" className="max-w-[280px]">
              <p>{deleteTooltipMessage}</p>
            </TooltipContent>
          )}
        </Tooltip>

        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={() => !isEditDisabled && onEdit(member)}
              disabled={isEditDisabled}
              className={`flex items-center gap-2 px-4 py-2 rounded-lg transition-colors ${
                isEditDisabled
                  ? "bg-muted/50 cursor-not-allowed opacity-50"
                  : "bg-muted hover:bg-muted/80"
              }`}
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
                <path d="m15 5 4 4" />
              </svg>
              <span className="text-sm font-medium">Edit</span>
            </button>
          </TooltipTrigger>
          {isEditDisabled && editTooltipMessage && (
            <TooltipContent side="top" className="max-w-[280px]">
              <p>{editTooltipMessage}</p>
            </TooltipContent>
          )}
        </Tooltip>
      </div>
    </div>
  );
}

