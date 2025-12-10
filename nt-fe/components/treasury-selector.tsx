"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { useTreasury } from "@/stores/treasury-store";
import { Database } from "lucide-react";
import Link from "next/link";
import { useNear } from "@/stores/near-store";
import { useUserTreasuries } from "@/hooks/use-treasury-queries";

export function TreasurySelector() {
  const { selectedTreasury, setSelectedTreasury } = useTreasury();
  const { accountId, } = useNear();

  const { data: treasuries = [], isLoading } = useUserTreasuries(accountId);

  const currentTreasury = treasuries.find(t => t.daoId === selectedTreasury);

  React.useEffect(() => {
    if (treasuries.length > 0 && !selectedTreasury) {
      setSelectedTreasury(treasuries[0].daoId);
    }
  }, [treasuries]);

  if (isLoading) {
    return (
      <div className="w-full px-2.5 py-2 h-14 flex items-center">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-muted-foreground animate-pulse" />
          <span className="text-sm text-muted-foreground">Loading treasuries...</span>
        </div>
      </div>
    );
  }

  if (!accountId) {
    return (
      <div className="w-full px-2.5 py-2 h-14 flex items-center">
        <div className="flex items-center gap-2">
          <Database className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">Connect wallet to view treasuries</span>
        </div>
      </div>
    );
  }

  const getTreasuryName = (treasury: typeof treasuries[0]) => {
    return treasury.config?.name || treasury.daoId;
  };

  return (
    <Select value={selectedTreasury} onValueChange={setSelectedTreasury} >
      <SelectTrigger className="w-full px-2.5 py-2 border-none! ring-0! shadow-none! bg-transparent! hover:bg-muted! h-14!">
        <div className="flex items-center gap-2 w-full ">
          <div className="flex items-center justify-center w-7 h-7 rounded shrink-0">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="flex flex-col items-start flex-1 min-w-0">
            <span className="text-sm font-medium truncate max-w-full leading-snug">
              {currentTreasury ? getTreasuryName(currentTreasury) : "Select treasury"}
            </span>
            {currentTreasury && (
              <span className="text-xs text-muted-foreground leading-none">
                {currentTreasury.daoId}
              </span>
            )}
          </div>
        </div>
      </SelectTrigger>
      <SelectContent>
        {treasuries.map((treasury) => (
          <SelectItem
            key={treasury.daoId}
            value={treasury.daoId}
            className=" focus:text-accent-foreground py-3"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded">
                <Database className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium">{getTreasuryName(treasury)}</span>
                <span className="text-xs text-muted-foreground">
                  {treasury.daoId}
                </span>
              </div>
            </div>
          </SelectItem>
        ))}
        <SelectSeparator />
        <Link
          href="/app/new"
          className="w-full flex items-center gap-2 px-2 py-3 text-sm text-muted-foreground hover:text-foreground transition-colors rounded-lg"
        >
          <span className="text-lg">+</span>
          <span>Create Treasury</span>
        </Link>
      </SelectContent>
    </Select>
  );
}
