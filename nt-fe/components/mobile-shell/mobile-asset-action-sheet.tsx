"use client";

import {
    ArrowDataTransferHorizontalIcon,
    SentIcon,
} from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthButton } from "@/components/auth-button";
import { Icon } from "@/components/icon";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import { Dialog, DialogContent, DialogTitle } from "@/components/modal";
import type { AggregatedAsset } from "@/hooks/use-assets";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";

const ACTION_CLASS =
    "h-14 w-full justify-start gap-3 rounded-2xl bg-gray-100 px-5 text-base font-semibold text-foreground shadow-none hover:bg-general-unofficial-ghost-hover dark:bg-white/10";

interface Props {
    asset: AggregatedAsset | null;
    sendHref: string;
    swapHref: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    availableAmount: string;
}

export function MobileAssetActionSheet({
    asset,
    sendHref,
    swapHref,
    open,
    onOpenChange,
    availableAmount,
}: Props) {
    const t = useTranslations("assetsTable");
    const router = useRouter();
    const { treasuryId } = useTreasury();

    if (!asset) return null;

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent
                className="gap-3"
                onOpenAutoFocus={(event) => event.preventDefault()}
            >
                <SheetHandle />
                <DialogTitle className="sr-only">{asset.name}</DialogTitle>
                <div className="mb-4 flex items-center gap-3">
                    <img
                        src={asset.icon}
                        alt={asset.name}
                        className="size-11 shrink-0 rounded-full"
                    />
                    <div className="min-w-0">
                        <p className="truncate font-semibold text-foreground">
                            {asset.name}
                        </p>
                        <p className="truncate text-sm text-muted-foreground">
                            {availableAmount}
                        </p>
                    </div>
                </div>
                <div className="flex flex-col gap-2">
                    <AuthButton
                        permissionKind="transfer"
                        permissionAction="AddProposal"
                        variant="unstyled"
                        className={ACTION_CLASS}
                        data-testid="asset-row-action-send"
                        onClick={() => {
                            trackEvent("nav-click", {
                                destination: "payments",
                                source: "dashboard-assets",
                                treasury_id: treasuryId,
                            });
                            onOpenChange(false);
                            router.push(sendHref);
                        }}
                    >
                        <Icon icon={SentIcon} />
                        {t("send")}
                    </AuthButton>
                    <AuthButton
                        permissionKind="call"
                        permissionAction="AddProposal"
                        variant="unstyled"
                        className={ACTION_CLASS}
                        data-testid="asset-row-action-swap"
                        onClick={() => {
                            trackEvent("nav-click", {
                                destination: "exchange",
                                source: "dashboard-assets",
                                treasury_id: treasuryId,
                            });
                            onOpenChange(false);
                            router.push(swapHref);
                        }}
                    >
                        <Icon icon={ArrowDataTransferHorizontalIcon} />
                        {t("swap")}
                    </AuthButton>
                </div>
            </DialogContent>
        </Dialog>
    );
}
