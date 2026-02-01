"use client";

import * as React from "react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
} from "@/components/ui/select";
import { Database } from "lucide-react";
import { useRouter, usePathname } from "next/navigation";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { useOpenTreasury } from "@/hooks/use-open-treasury";
import { useAssets } from "@/hooks/use-assets";
import { formatCurrency, cn } from "@/lib/utils";
import { Button } from "./button";
import { Tooltip } from "./tooltip";
import { Skeleton } from "./ui/skeleton";

const TreasuryBalance = ({ daoId }: { daoId: string }) => {
  const { data, isLoading } = useAssets(daoId);
  if (isLoading) return <Skeleton className="size-4" />;
  if (data?.totalBalanceUSD === undefined) return null;
  return (
    <span className="text-xs text-muted-foreground">
      {formatCurrency(Number(data.totalBalanceUSD))}
    </span>
  );
};

const Logo = ({ logo }: { logo?: string }) => {
  if (logo) {
    return <img src={logo} alt="Treasury Flag Logo" className="rounded-md size-7 shrink-0 object-cover" />;
  }
  return <div className="flex items-center justify-center size-7 rounded bg-muted shrink-0">
    <Database className="size-5 text-muted-foreground" />
  </div>;
};

interface TreasurySelectorProps {
  reducedMode?: boolean;
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function TreasurySelector({ reducedMode = false, isOpen, onOpenChange }: TreasurySelectorProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { accountId } = useNear();
  const { open } = useOpenTreasury();

  const {
    isLoading,
    treasuryId,
    config,
    treasuries,
  } = useTreasury();

  const { data: assetsData } = useAssets(treasuryId);
  const totalBalanceUSD = assetsData?.totalBalanceUSD;

  // Auto-register treasury when it's selected/viewed
  React.useEffect(() => {
    open(treasuryId);
  }, [treasuryId, open]);

  React.useEffect(() => {
    if (treasuries.length > 0 && !treasuryId) {
      router.push(`/${treasuries[0].daoId}`);
    }
  }, [treasuries, treasuryId, router]);

  if (isLoading) {
    return (
      <div className={cn(
        "w-full h-fit flex items-center",
        reducedMode ? "px-2 py-1 justify-center" : "px-3 py-1.5"
      )}>
        <div className={cn(
          "flex items-center h-9",
          reducedMode ? "justify-center" : "gap-2"
        )}>
          <Skeleton className="size-7 rounded-md" />
          {!reducedMode && (
            <div className="flex flex-col gap-1">
              <Skeleton className="h-3 w-24" />
              <Skeleton className="h-3 w-32" />
            </div>
          )}
        </div>
      </div>
    );
  }

  const handleTreasuryChange = (newTreasuryId: string) => {
    const pathAfterTreasury = pathname?.split('/').slice(2).join('/') || '';
    router.push(`/${newTreasuryId}/${pathAfterTreasury}`);
  };


  const displayName = config
    ? config.name ?? treasuryId
    : "Select treasury";

  const displaySubtext = totalBalanceUSD !== undefined
    ? formatCurrency(Number(totalBalanceUSD))
    : undefined;

  return (
    <Select value={treasuryId} open={isOpen} onValueChange={handleTreasuryChange} onOpenChange={onOpenChange}>
      <SelectTrigger
        id="dashboard-step5"
        className={cn(
          "w-full h-fit border-none! ring-0! shadow-none! bg-transparent! hover:bg-muted!",
          reducedMode ? "p-0 [&>svg]:hidden" : "px-3 py-1.5"
        )}
        disabled={!accountId}
      >
        <Tooltip content="Connect wallet to view treasuries" disabled={!!accountId}>
          <div className={cn(
            "flex items-center w-full truncate",
            reducedMode ? "justify-center h-7" : "gap-2 max-w-52 h-9"
          )}>
            <Logo logo={config?.metadata?.flagLogo} />
            {!reducedMode && (
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
            )}
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
