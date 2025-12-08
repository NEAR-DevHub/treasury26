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

const treasuries = [
  { name: "NextCore Solutions", value: "nextcore.sputnikdao.near", balance: 45400.00 },
  { name: "DevHub", value: "devdao.sputnikdao.near", balance: 12500.00 },
  { name: "Nearn-Staging", value: "nearn-staging.sputnikdao.near", balance: 8300.00 },
];

export function TreasurySelector() {
  const { selectedTreasury, setSelectedTreasury } = useTreasury();

  const currentTreasury = treasuries.find(t => t.value === selectedTreasury);

  return (
    <Select value={selectedTreasury} onValueChange={setSelectedTreasury} >
      <SelectTrigger className="w-full px-2.5 py-2 border-none! ring-0! shadow-none! bg-transparent! hover:bg-muted! h-14!">
        <div className="flex items-center gap-2 w-full ">
          <div className="flex items-center justify-center w-7 h-7 rounded shrink-0">
            <Database className="h-3.5 w-3.5 text-muted-foreground" />
          </div>
          <div className="flex flex-col items-start flex-1 min-w-0">
            <span className="text-sm font-medium truncate max-w-full leading-snug">
              {currentTreasury?.name || "Select treasury"}
            </span>
            {currentTreasury && (
              <span className="text-xs text-muted-foreground leading-none">
                ${currentTreasury.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}
          </div>
        </div>
      </SelectTrigger>
      <SelectContent>
        {treasuries.map((treasury) => (
          <SelectItem
            key={treasury.value}
            value={treasury.value}
            className=" focus:text-accent-foreground py-3"
          >
            <div className="flex items-center gap-3">
              <div className="flex items-center justify-center w-10 h-10 rounded">
                <Database className="h-5 w-5 text-muted-foreground" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium">{treasury.name}</span>
                <span className="text-xs text-muted-foreground">
                  ${treasury.balance.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
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
