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
import { useRouter, usePathname } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useIsGuestTreasury } from "@/hooks/use-is-guest-treasury";
import { Button } from "./button";
import { Tooltip } from "./tooltip";

export function TreasurySelector() {
  const router = useRouter();
  const pathname = usePathname();
  const { setSelectedTreasury } = useTreasury();
  const { accountId } = useNear();

  const {
    isLoading,
    treasuryId,
    currentTreasury,
    guestTreasuryConfig,
    treasuries,
  } = useIsGuestTreasury();

  React.useEffect(() => {
    if (treasuryId) {
      if (currentTreasury) {
        // User owns this treasury
        setSelectedTreasury({
          daoId: treasuryId,
          name: currentTreasury.config?.name || "",
          flagLogo: currentTreasury.config?.metadata?.flagLogo || ""
        });
      } else if (guestTreasuryConfig) {
        // Guest viewing a treasury
        setSelectedTreasury({
          daoId: treasuryId,
          name: guestTreasuryConfig.name || "",
          flagLogo: guestTreasuryConfig.metadata?.flagLogo || ""
        });
      }
    }
  }, [treasuryId, currentTreasury, guestTreasuryConfig, setSelectedTreasury]);

  React.useEffect(() => {
    if (treasuries.length > 0 && !treasuryId) {
      router.push(`/${treasuries[0].daoId}`);
    }
  }, [treasuries, treasuryId, router]);

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

  const handleTreasuryChange = (newTreasuryId: string) => {
    const pathAfterTreasury = pathname?.split('/').slice(2).join('/') || '';
    router.push(`/${newTreasuryId}/${pathAfterTreasury}`);
  };

  const Logo = ({ logo }: { logo?: string }) => {
    if (logo) {
      return <img src={logo} alt="Treasury Flag Logo" className="rounded-md size-7 object-cover" />;
    }
    return <div className="flex items-center justify-center size-7 rounded bg-muted shrink-0">
      <Database className="size-5 text-muted-foreground" />
    </div>;
  }

  const displayTreasury = currentTreasury?.config ?? guestTreasuryConfig;

  const displayName = displayTreasury
    ? displayTreasury.name ?? treasuryId
    : "Select treasury";

  const displaySubtext = treasuryId;

  return (
    <Select value={treasuryId} onValueChange={handleTreasuryChange} >
      <SelectTrigger className="w-full px-3 py-1.5 h-fit border-none! ring-0! shadow-none! bg-transparent! hover:bg-muted!" disabled={!accountId}>
        <Tooltip content="Connect wallet to view treasuries" disabled={!!accountId}>
          <div className="flex items-center gap-2 w-full max-w-52 truncate h-9">
            <Logo logo={currentTreasury?.config?.metadata?.flagLogo} />
            <div className="flex flex-col items-start min-w-0">
              <span className="text-xs font-medium truncate max-w-full ">
                {displayName}
              </span>
              {displaySubtext && (
                <span className="text-xs text-muted-foreground truncate max-w-full font-medium">
                  {displaySubtext}
                </span>
              )}
            </div>
          </div>
        </Tooltip>
      </SelectTrigger>
      <SelectContent>
        {treasuries.map((treasury) => (
          <SelectItem
            key={treasury.daoId}
            value={treasury.daoId}
            className=" focus:text-accent-foreground py-3"
          >
            <div className="flex items-center gap-3">
              <Logo logo={treasury.config.metadata?.flagLogo} />
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium">{treasury.config?.name ?? treasury.daoId}</span>
                <span className="text-xs text-muted-foreground">
                  {treasury.daoId}
                </span>
              </div>
            </div>
          </SelectItem>
        ))}
        <SelectSeparator />
        <Button
          variant="ghost"
          type="button"
          className="w-full justify-start gap-2"
          onClick={() => router.push("/app/new")}
        >
          <span className="text-lg">+</span>
          <span>Create Treasury</span>
        </Button>
      </SelectContent>
    </Select >
  );
}
