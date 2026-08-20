"use client";
import { Icon } from "@/components/icon";
import { Loading02Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Skeleton } from "@/components/ui/skeleton";
import {
    useDisconnectTelegramTreasury,
    useTelegramStatuses,
} from "@/hooks/use-telegram";
import { useTreasury } from "@/hooks/use-treasury";
import { TelegramConnectInstructionsModal } from "./telegram-connect-instructions-modal";

function TelegramInfoBlock({
    title,
    description,
}: {
    title: string;
    description: string;
}) {
    return (
        <div className="flex items-start gap-4 min-w-0 flex-1">
            <img
                src="/icons/telegram.svg"
                alt=""
                width={40}
                height={40}
                className="size-10 shrink-0 rounded-lg object-contain"
                aria-hidden
                draggable={false}
            />
            <div className="min-w-0">
                <div className="text-lg font-semibold text-foreground">
                    {title}
                </div>
                <div className="text-xs leading-snug text-muted-foreground">
                    {description}
                </div>
            </div>
        </div>
    );
}

export function TelegramSettingsIntegration() {
    const t = useTranslations("telegram.settings");
    const { treasuryId } = useTreasury();
    const [connectModalOpen, setConnectModalOpen] = useState(false);
    const [disconnectModalOpen, setDisconnectModalOpen] = useState(false);
    const disconnectMutation = useDisconnectTelegramTreasury();

    const statusQueries = useTelegramStatuses(treasuryId ? [treasuryId] : []);
    const statusResult =
        treasuryId && statusQueries.length > 0 ? statusQueries[0] : undefined;
    const telegramStatus = statusResult?.data;
    const isLoadingStatus =
        !!treasuryId && !!(statusResult?.isLoading || statusResult?.isPending);

    const chatLabel =
        telegramStatus?.chatTitle?.trim() ||
        (telegramStatus?.chatId != null
            ? t("chatNumber", { id: telegramStatus.chatId })
            : null);
    const connectedChatDisplay = chatLabel ?? t("fallbackChat");

    const handleDisconnect = () => {
        if (!treasuryId) return;
        disconnectMutation.mutate(treasuryId, {
            onSuccess: () => {
                setDisconnectModalOpen(false);
                toast.success(t("disconnectedToast"));
            },
            onError: () => {
                toast.error(t("disconnectFailedToast"));
            },
        });
    };

    return (
        <>
            <PageCard>
                {telegramStatus?.connected && treasuryId && !isLoadingStatus ? (
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                        <TelegramInfoBlock
                            title={t("title")}
                            description={t("connectedTo", {
                                chat: connectedChatDisplay,
                            })}
                        />
                        <Button
                            type="button"
                            variant="outline"
                            className="w-full shrink-0 rounded-lg sm:w-auto"
                            disabled={disconnectMutation.isPending}
                            onClick={() => setDisconnectModalOpen(true)}
                        >
                            {disconnectMutation.isPending && (
                                <Icon
                                    icon={Loading02Icon}
                                    className="animate-spin"
                                />
                            )}
                            {t("disconnect")}
                        </Button>
                    </div>
                ) : (
                    <div className="flex flex-col gap-4 w-full">
                        {!treasuryId ? (
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <TelegramInfoBlock
                                    title={t("connectHeadline")}
                                    description={t("openSettingsHint")}
                                />
                                <Button
                                    type="button"
                                    disabled
                                    className="w-full shrink-0 rounded-lg bg-black text-white hover:bg-black/90 sm:w-auto dark:bg-black dark:text-white dark:hover:bg-black/90"
                                >
                                    {t("connect")}
                                </Button>
                            </div>
                        ) : isLoadingStatus ? (
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                                <div className="flex items-start gap-4 flex-1">
                                    <Skeleton className="size-10 shrink-0 rounded-lg" />
                                    <div className="flex flex-col gap-2 flex-1 pt-1">
                                        <Skeleton className="h-5 w-48 max-w-full" />
                                        <Skeleton className="h-4 w-full max-w-lg" />
                                    </div>
                                </div>
                                <Skeleton className="h-10 w-24 shrink-0 rounded-lg self-center" />
                            </div>
                        ) : (
                            <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
                                <TelegramInfoBlock
                                    title={t("connectHeadline")}
                                    description={t("connectDescription")}
                                />
                                <Button
                                    type="button"
                                    onClick={() => setConnectModalOpen(true)}
                                    className="w-full shrink-0 rounded-lg bg-black text-white hover:bg-black/90 sm:w-auto dark:bg-black dark:text-white dark:hover:bg-black/90"
                                >
                                    {t("connect")}
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </PageCard>

            <TelegramConnectInstructionsModal
                open={connectModalOpen}
                onOpenChange={setConnectModalOpen}
            />

            <Dialog
                open={disconnectModalOpen}
                onOpenChange={setDisconnectModalOpen}
            >
                <DialogContent className="max-w-md gap-4">
                    <DialogHeader>
                        <DialogTitle className="text-left">
                            {t("telegramDisconnect.title")}
                        </DialogTitle>
                    </DialogHeader>
                    <DialogDescription>
                        <div className="flex flex-col gap-4">
                            {t("telegramDisconnect.body")}

                            <Button
                                type="button"
                                onClick={handleDisconnect}
                                disabled={disconnectMutation.isPending}
                                className="w-full rounded-[10px] bg-[#1A1617] text-white hover:bg-[#1A1617]/90"
                            >
                                {disconnectMutation.isPending && (
                                    <Icon
                                        icon={Loading02Icon}
                                        className="animate-spin"
                                    />
                                )}
                                {t("telegramDisconnect.action")}
                            </Button>
                        </div>
                    </DialogDescription>
                </DialogContent>
            </Dialog>
        </>
    );
}
