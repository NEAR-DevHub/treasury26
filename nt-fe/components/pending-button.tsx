"use client";

import { Button } from "@/components/button";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { useRouter } from "next/navigation";

interface PendingButtonProps {
  /** High-level category types from backend: "Payments", "Exchange", "Change Policy", etc. */
  types?: string[];
  id?: string;
}

export function PendingButton({ types, id }: PendingButtonProps) {
  const { treasuryId } = useTreasury();
  const router = useRouter();

  const { data: pendingProposals } = useProposals(treasuryId, {
    statuses: ["InProgress"],
    types,
    sort_direction: "desc",
    sort_by: "CreationTime",
  });

  return (
    <Button
      id={id}
      type="button"
      onClick={() =>
        router.push(`/${treasuryId}/requests?tab=pending`)
      }
      variant="ghost"
      className="flex items-center gap-2 border-2"
    >
      Pending
      <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs">
        {pendingProposals?.proposals?.length || 0}
      </span>
    </Button>
  );
}
