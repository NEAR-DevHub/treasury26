"use client";

import { Button } from "@/components/button";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/stores/treasury-store";
import { useRouter } from "next/navigation";

interface PendingButtonProps {
  /** High-level category types from backend: "Payments", "Exchange", "Change Policy", etc. */
  types?: string[];
  id?: string;
}

export function PendingButton({ types, id }: PendingButtonProps) {
  const { selectedTreasury } = useTreasury();
  const router = useRouter();

  const { data: pendingProposals } = useProposals(selectedTreasury, {
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
        router.push(`/${selectedTreasury}/requests?tab=pending`)
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
