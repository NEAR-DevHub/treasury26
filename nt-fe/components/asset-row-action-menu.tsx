"use client";

import { SentIcon, SquareArrowLeftRightIcon } from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AuthButton } from "@/components/auth-button";
import { Icon } from "@/components/icon";
import { PopoverArrow, PopoverContent } from "@/components/ui/popover";
import { useTreasury } from "@/hooks/use-treasury";
import { trackEvent } from "@/lib/analytics";

const MENU_ITEM_CLASS =
    "inline-flex h-10 min-h-10 max-h-10 w-auto shrink-0 items-center gap-2 rounded-none bg-transparent px-3 py-2 font-semibold text-sm leading-[1.5] text-white shadow-none hover:bg-white/10 hover:text-white focus-visible:border-transparent focus-visible:bg-white/10 focus-visible:ring-0";

interface Props {
    sendHref: string;
    swapHref: string;
}

export function AssetRowActionMenu({ sendHref, swapHref }: Props) {
    const t = useTranslations("assetsTable");
    const router = useRouter();
    const { treasuryId } = useTreasury();

    return (
        <PopoverContent
            side="bottom"
            align="center"
            sideOffset={8}
            className="w-auto rounded-2xl border border-gray-800 bg-gray-900 p-0 text-white shadow-lg"
            data-testid="asset-row-actions"
            onOpenAutoFocus={(event) => event.preventDefault()}
        >
            <PopoverArrow width={12} height={6} />
            <div className="flex items-center">
                <AuthButton
                    permissionKind="call"
                    permissionAction="AddProposal"
                    variant="unstyled"
                    className={MENU_ITEM_CLASS}
                    data-testid="asset-row-action-swap"
                    onClick={() => {
                        trackEvent("nav-click", {
                            destination: "exchange",
                            source: "dashboard-assets",
                            treasury_id: treasuryId,
                        });
                        router.push(swapHref);
                    }}
                >
                    <Icon icon={SquareArrowLeftRightIcon} />
                    {t("swap")}
                </AuthButton>
                <AuthButton
                    permissionKind="transfer"
                    permissionAction="AddProposal"
                    variant="unstyled"
                    className={MENU_ITEM_CLASS}
                    data-testid="asset-row-action-send"
                    onClick={() => {
                        trackEvent("nav-click", {
                            destination: "payments",
                            source: "dashboard-assets",
                            treasury_id: treasuryId,
                        });
                        router.push(sendHref);
                    }}
                >
                    <Icon icon={SentIcon} />
                    {t("send")}
                </AuthButton>
            </div>
        </PopoverContent>
    );
}
