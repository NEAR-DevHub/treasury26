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
import { useOpenTreasury } from "@/hooks/use-open-treasury";
import { useTreasuryAssets } from "@/hooks/use-treasury-queries";
import { formatCurrency } from "@/lib/utils";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { Skeleton } from "./ui/skeleton";

export function TreasurySelector() {
  const router = useRouter();
  const pathname = usePathname();
  const { setSelectedTreasury } = useTreasury();
  const { accountId } = useNear();
  const { open } = useOpenTreasury();

  const {
    isLoading,
    treasuryId,
    currentTreasury,
    guestTreasuryConfig,
    treasuries,
  } = useIsGuestTreasury();

  const { data: assetsData } = useTreasuryAssets(treasuryId);
  const totalBalanceUSD = assetsData?.totalBalanceUSD;

  // Auto-register treasury when it's selected/viewed
  React.useEffect(() => {
    open(treasuryId);
  }, [treasuryId, open]);

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
      <div className="w-full px-3 py-1.5 h-fit flex items-center">
        <div className="flex items-center gap-2 h-9">
          <Skeleton className="size-7 rounded-md" />
          <div className="flex flex-col gap-1">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-32" />
          </div>
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
  };

  const TreasuryBalance = ({ daoId }: { daoId: string }) => {
    const { data, isLoading } = useTreasuryAssets(daoId);
    if (isLoading) return <Skeleton className="size-4" />;
    if (data?.totalBalanceUSD === undefined) return null;
    return (
      <span className="text-xs text-muted-foreground">
        {formatCurrency(Number(data.totalBalanceUSD))}
      </span>
    );
  };

  const displayTreasury = currentTreasury?.config ?? guestTreasuryConfig;

  const displayName = displayTreasury
    ? displayTreasury.name ?? treasuryId
    : "Select treasury";

  const displaySubtext = totalBalanceUSD !== undefined
    ? formatCurrency(Number(totalBalanceUSD))
    : undefined;

  return (
    <Select value={treasuryId} onValueChange={handleTreasuryChange}>
      <SelectTrigger id="dashboard-step5" className="w-full px-3 py-1.5 h-fit border-none! ring-0! shadow-none! bg-transparent! hover:bg-muted!" disabled={!accountId}>
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
            className=" focus:text-accent-foreground"
          >
            <div className="flex items-center gap-3">
              <Logo logo={treasury.config.metadata?.flagLogo} />
              <div className="flex flex-col items-start">
                <span className="text-sm font-medium">{treasury.config?.name ?? treasury.daoId}</span>
                <TreasuryBalance daoId={treasury.daoId} />
              </div>
            </div>
          </SelectItem>
        ))}
        <SelectSeparator />
        <Button
          id="dashboard-step5-create-treasury"
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
