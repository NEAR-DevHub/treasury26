"use client";

import Link from "next/link";
import {
    CircleCheckIcon,
    Unlink01Icon,
    Wallet01Icon,
} from "@hugeicons/core-free-icons";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { InfoAlert } from "@/components/info-alert";
import Logo from "@/components/icons/logo";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepperHeader } from "@/components/step-wizard";
import { TreasuryLogo } from "@/components/treasury-info";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import {
    useConnectTreasuries,
    useTelegramChatInfo,
    useTelegramStatuses,
} from "@/hooks/use-telegram";
import { useTreasury } from "@/hooks/use-treasury";
import { useUserTreasuries } from "@/hooks/use-treasury-queries";
import type { Treasury } from "@/lib/api";
import type { ConnectedTreasury, TelegramStatus } from "@/lib/telegram-api";
import { useNear } from "@/stores/near-store";

function TelegramConnectShell({ children }: { children: React.ReactNode }) {
    const tPage = useTranslations("pages.telegram");
    const tTg = useTranslations("telegram");
    return (
        <PageComponentLayout
            title={tPage("title")}
            description={tPage("description")}
            hideCollapseButton
            logo={
                <div className="flex items-center gap-2.5">
                    <Link href="/">
                        <Logo size="sm" />
                    </Link>
                    <span className="hidden sm:inline text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded-full">
                        {tTg("tagPill")}
                    </span>
                </div>
            }
        >
            <div className="max-w-3xl mx-auto">{children}</div>
        </PageComponentLayout>
    );
}

function LoadingCard() {
    return (
        <PageCard>
            <div className="flex flex-col gap-1">
                <Skeleton className="h-5 w-40" />
                <Skeleton className="h-4 w-72" />
            </div>
            <div className="flex flex-col gap-2">
                <Skeleton className="h-14 w-full rounded-md" />
                <Skeleton className="h-14 w-full rounded-md" />
                <Skeleton className="h-14 w-full rounded-md" />
            </div>
            <Skeleton className="h-9 w-full rounded-md" />
        </PageCard>
    );
}

function MessageCard({
    title,
    description,
    action,
}: {
    title: string;
    description: string;
    action?: React.ReactNode;
}) {
    return (
        <PageCard>
            <div className="flex flex-col gap-1">
                <StepperHeader title={title} />
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            {action}
        </PageCard>
    );
}

function ConnectPageInner() {
    const tTg = useTranslations("telegram");
    const { lastTreasuryId } = useTreasury();
    const token = useSearchParams().get("token") ?? "";
    const { accountId, isInitializing, connect } = useNear();
    const isAuthorized = !!accountId;
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [didInitializeSelection, setDidInitializeSelection] = useState(false);
    const [didShowSuccessToast, setDidShowSuccessToast] = useState(false);

    const chatInfoQuery = useTelegramChatInfo(token, { enabled: !!token });
    const treasuriesQuery = useUserTreasuries(accountId);
    const connectMutation = useConnectTreasuries(token);

    const chatInfo = chatInfoQuery.data;
    const treasuries = treasuriesQuery.data ?? [];
    const visibleTreasuries = useMemo(
        () =>
            treasuries.filter(
                (treasury) => !(treasury.isSaved && !treasury.isMember),
            ),
        [treasuries],
    );
    const visibleDaoIds = useMemo(
        () => new Set(visibleTreasuries.map((treasury) => treasury.daoId)),
        [visibleTreasuries],
    );
    const connectedSet = useMemo(
        () =>
            new Set(
                chatInfo?.connectedTreasuries.map(
                    (t: ConnectedTreasury) => t.daoId,
                ) ?? [],
            ),
        [chatInfo],
    );

    const unconnectedIds = useMemo(
        () =>
            visibleTreasuries
                .map((treasury) => treasury.daoId)
                .filter((daoId) => !connectedSet.has(daoId)),
        [connectedSet, visibleTreasuries],
    );

    const statusResults = useTelegramStatuses(unconnectedIds);
    const statusMap = useMemo(() => {
        const map: Record<string, TelegramStatus> = {};
        unconnectedIds.forEach((daoId, index) => {
            const status = statusResults[index]?.data;
            if (status?.connected) {
                map[daoId] = status;
            }
        });
        return map;
    }, [statusResults, unconnectedIds]);

    useEffect(() => {
        if (didInitializeSelection) return;
        if (!chatInfo || treasuriesQuery.isLoading) return;
        setSelectedIds(
            new Set(
                Array.from(connectedSet).filter((daoId) =>
                    visibleDaoIds.has(daoId),
                ),
            ),
        );
        setDidInitializeSelection(true);
    }, [
        chatInfo,
        connectedSet,
        didInitializeSelection,
        treasuriesQuery.isLoading,
        visibleDaoIds,
    ]);

    const handleToggle = (daoId: string) => {
        setSelectedIds((prev: Set<string>) => {
            const next = new Set(prev);
            if (next.has(daoId)) {
                next.delete(daoId);
            } else {
                next.add(daoId);
            }
            return next;
        });
    };

    const handleConnect = () => {
        connectMutation.mutate(Array.from(selectedIds));
    };

    const relinkingFromOtherChats = useMemo(
        () =>
            Array.from(selectedIds)
                .map((daoId) => ({ daoId, status: statusMap[daoId] }))
                .filter((entry) => !!entry.status),
        [selectedIds, statusMap],
    );
    const relinkingCount = relinkingFromOtherChats.length;

    const isDataLoading =
        isInitializing ||
        chatInfoQuery.isLoading ||
        (isAuthorized && treasuriesQuery.isLoading);
    const isConnecting = connectMutation.isPending;

    useEffect(() => {
        if (!connectMutation.isSuccess || didShowSuccessToast) return;
        setDidShowSuccessToast(true);
        toast.success(tTg("successToast"));
    }, [connectMutation.isSuccess, didShowSuccessToast]);

    if (!token) {
        return (
            <TelegramConnectShell>
                <MessageCard
                    title={tTg("invalidLinkTitle")}
                    description={tTg("invalidLinkDescription")}
                />
            </TelegramConnectShell>
        );
    }

    if (isDataLoading) {
        return (
            <TelegramConnectShell>
                <LoadingCard />
            </TelegramConnectShell>
        );
    }

    if (connectMutation.isSuccess) {
        return (
            <TelegramConnectShell>
                <PageCard className="min-h-[320px] flex items-center justify-center">
                    <div className="w-full max-w-md flex flex-col gap-5">
                        <EmptyState
                            icon={CircleCheckIcon}
                            title={tTg("successTitle")}
                            description={tTg("successDescription")}
                            className="py-0"
                        />
                        <Button className="w-full" asChild>
                            <Link
                                href={
                                    lastTreasuryId ? `/${lastTreasuryId}` : "/"
                                }
                            >
                                {tTg("goToApp")}
                            </Link>
                        </Button>
                    </div>
                </PageCard>
            </TelegramConnectShell>
        );
    }

    if (chatInfoQuery.error) {
        const status = (
            chatInfoQuery.error as { response?: { status?: number } }
        )?.response?.status;
        if (status === 404 || status === 410) {
            return (
                <TelegramConnectShell>
                    <PageCard className="min-h-[320px] flex items-center justify-center">
                        <div className="w-full max-w-md flex flex-col gap-5">
                            <EmptyState
                                icon={Unlink01Icon}
                                title={tTg("linkExpiredTitle")}
                                description={tTg("linkExpiredDescription")}
                                className="py-0"
                            />
                            <div className="rounded-md bg-general-tertiary p-2 flex items-center justify-between gap-2">
                                <code className="text-sm font-medium">
                                    /connect
                                </code>
                                <CopyButton
                                    text="/connect"
                                    toastMessage={tTg("commandCopied")}
                                    variant="secondary"
                                    size="sm"
                                >
                                    {tTg("copy")}
                                </CopyButton>
                            </div>
                        </div>
                    </PageCard>
                </TelegramConnectShell>
            );
        }
        return (
            <TelegramConnectShell>
                <MessageCard
                    title={tTg("unableToLoadTitle")}
                    description={tTg("unableToLoadDescription")}
                />
            </TelegramConnectShell>
        );
    }

    if (!isAuthorized) {
        return (
            <TelegramConnectShell>
                <PageCard className="min-h-[320px] flex items-center justify-center">
                    <div className="w-full max-w-md flex flex-col gap-5">
                        <EmptyState
                            icon={Wallet01Icon}
                            title={tTg("signInTitle")}
                            description={tTg("signInDescription")}
                            className="py-0"
                        />
                        <Button className="w-full" onClick={() => connect()}>
                            {tTg("connectWallet")}
                        </Button>
                    </div>
                </PageCard>
            </TelegramConnectShell>
        );
    }

    return (
        <TelegramConnectShell>
            <PageCard>
                <div className="flex flex-col gap-1">
                    <StepperHeader
                        title={tTg("selectTreasuriesTitle")}
                        description={tTg("selectTreasuriesDescription")}
                    />
                    {chatInfo && (
                        <div className="mt-2 flex items-center gap-2">
                            <img
                                src="/icons/telegram.svg"
                                alt=""
                                className="size-9 shrink-0 rounded-sm object-contain"
                                aria-hidden
                                draggable={false}
                            />
                            <div className="min-w-0">
                                <p className="text-xs text-muted-foreground">
                                    {tTg("telegramChat")}
                                </p>
                                <p className="text-sm font-medium truncate">
                                    {chatInfo.chatTitle ||
                                        tTg("chatIdFallback", {
                                            id: chatInfo.chatId,
                                        })}
                                </p>
                            </div>
                        </div>
                    )}
                </div>

                {connectMutation.error && (
                    <p className="text-sm text-destructive">
                        {(
                            connectMutation.error as {
                                response?: { data?: string };
                            }
                        )?.response?.data ?? tTg("failedToConnect")}
                    </p>
                )}
                {relinkingCount > 0 && (
                    <InfoAlert
                        message={tTg("relinking", { count: relinkingCount })}
                    />
                )}

                <div className="flex flex-col gap-2">
                    {visibleTreasuries.map((treasury: Treasury) => {
                        const alreadyHere = connectedSet.has(treasury.daoId);
                        const elsewhereStatus = statusMap[treasury.daoId];
                        const checked = selectedIds.has(treasury.daoId);

                        return (
                            <div
                                key={treasury.daoId}
                                className="grid grid-cols-[auto_1fr_auto] gap-3 items-center rounded-md bg-general-tertiary px-3 py-2"
                            >
                                <Checkbox
                                    id={treasury.daoId}
                                    checked={checked}
                                    disabled={isConnecting}
                                    onCheckedChange={() =>
                                        handleToggle(treasury.daoId)
                                    }
                                    className="self-center"
                                />
                                <label
                                    htmlFor={treasury.daoId}
                                    className="cursor-pointer flex items-center gap-2.5 min-w-0"
                                >
                                    <TreasuryLogo
                                        logo={
                                            treasury.config?.metadata?.flagLogo
                                        }
                                    />
                                    <span className="block min-w-0">
                                        <span className="block text-sm font-medium truncate">
                                            {treasury.config.name ??
                                                treasury.daoId}
                                        </span>
                                        <span className="block text-xs text-muted-foreground truncate">
                                            {treasury.daoId}
                                        </span>
                                    </span>
                                </label>
                                {!alreadyHere && elsewhereStatus && (
                                    <span className="inline-flex shrink-0 whitespace-nowrap rounded-full bg-general-orange-background-faded px-2.5 py-0.5 text-xs font-medium text-general-orange-foreground">
                                        {tTg("connectedToAnother")}
                                    </span>
                                )}
                            </div>
                        );
                    })}
                </div>

                {visibleTreasuries.length === 0 && (
                    <p className="text-sm text-muted-foreground">
                        {tTg("notMember")}
                    </p>
                )}

                <Button
                    type="button"
                    className="w-full"
                    disabled={selectedIds.size === 0 || isConnecting}
                    onClick={handleConnect}
                >
                    {isConnecting ? tTg("connecting") : tTg("connect")}
                </Button>
            </PageCard>
        </TelegramConnectShell>
    );
}

export function TelegramConnectPage() {
    return (
        <Suspense
            fallback={
                <TelegramConnectShell>
                    <LoadingCard />
                </TelegramConnectShell>
            }
        >
            <ConnectPageInner />
        </Suspense>
    );
}
