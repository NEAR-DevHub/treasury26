import { User } from "@/components/user";
import { Button } from "@/components/button";
import { ArrowRight } from "lucide-react";
import { useRouter } from "next/navigation";

interface Member {
  accountId: string;
  roles: string[];
}

interface PendingMemberCardProps {
  member: Member & {
    addedRoles?: string[];
    removedRoles?: string[];
    isNewMember?: boolean;
  };
  proposalId: number;
  proposer: string;
  createdAt: string;
  treasuryId: string | null | undefined;
}

export function PendingMemberCard({
  member,
  proposalId,
  proposer,
  createdAt,
  treasuryId,
}: PendingMemberCardProps) {
  const router = useRouter();

  // Convert from nanoseconds to milliseconds
  const timestamp = typeof createdAt === 'string' ? parseInt(createdAt) : createdAt;
  const date = new Date(timestamp / 1_000_000);
  const formattedDate = date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <div className="rounded-lg border bg-card p-4 space-y-4 flex flex-col">
      {/* Member Header */}
      <User accountId={member.accountId} size="lg" withLink={false} />

      {/* Removed from roles section - Show first for edits */}
      {member.removedRoles && member.removedRoles.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">Removed from roles</p>
          <div className="flex flex-wrap gap-2">
            {member.removedRoles.map((role) => (
              <span
                key={role}
                className="px-3 py-1 rounded-md bg-muted text-foreground text-sm font-medium"
              >
                {role}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Added roles section */}
      {member.addedRoles && member.addedRoles.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-foreground">
            {member.isNewMember ? "Added with roles" : "Added to roles"}
          </p>
          <div className="flex flex-wrap gap-2">
            {member.addedRoles.map((role) => (
              <span
                key={role}
                className="px-3 py-1 rounded-md bg-muted text-foreground text-sm font-medium"
              >
                {role}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Request info */}
      <p className="text-sm text-muted-foreground">
        Created on {formattedDate} by <span className="font-medium">{proposer}</span>
      </p>

      {/* View Request Button - pushed to bottom */}
      <div className="pt-3 mt-auto">
        <Button
          variant="outline"
          className="w-full justify-center gap-2"
          onClick={() => router.push(`/${treasuryId}/requests/${proposalId}`)}
        >
          View Request
          <ArrowRight className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

