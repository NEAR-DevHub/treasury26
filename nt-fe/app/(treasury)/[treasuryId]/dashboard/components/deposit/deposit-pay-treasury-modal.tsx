"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { Dialog, DialogHeader, DialogTitle } from "@/components/modal";
import { PaymentSelectModalContent } from "@/components/payment-select-modal-content";
import { paymentSelectModalListClassName } from "@/components/selector-field";
import { TreasuryBalance, TreasuryLogo } from "@/components/treasury-info";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { Treasury } from "@/lib/api";

interface DepositPayTreasuryModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    treasuries: Treasury[];
    /** Destination treasury — excluded so users don't pay into themselves. */
    excludeTreasuryId?: string;
    /** Confidential share: only list confidential member treasuries. */
    confidentialOnly?: boolean;
    isLoading?: boolean;
    onSelect: (daoId: string) => void;
}

export function DepositPayTreasuryModal({
    open,
    onOpenChange,
    treasuries,
    excludeTreasuryId,
    confidentialOnly = false,
    isLoading = false,
    onSelect,
}: DepositPayTreasuryModalProps) {
    const t = useTranslations("depositModal.transfer");
    const memberTreasuries = treasuries.filter((treasury) => {
        if (!treasury.isMember) return false;
        if (treasury.daoId === excludeTreasuryId) return false;
        if (confidentialOnly && !treasury.isConfidential) return false;
        return true;
    });

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <PaymentSelectModalContent data-testid="deposit-pay-treasury-modal">
                <DialogHeader
                    centerTitle={false}
                    className="sticky top-0 border-0 pb-0 text-left"
                >
                    <DialogTitle className="pr-8 text-left text-lg font-semibold">
                        {t("chooseTreasuryTitle")}
                    </DialogTitle>
                </DialogHeader>

                <div className="mt-4 flex min-h-0 flex-1 flex-col space-y-4 sm:mt-0">
                    {isLoading ? (
                        <div className="space-y-2">
                            <Skeleton className="h-14 w-full rounded-xl" />
                            <Skeleton className="h-14 w-full rounded-xl" />
                            <Skeleton className="h-14 w-full rounded-xl" />
                        </div>
                    ) : memberTreasuries.length === 0 ? (
                        <div className="rounded-xl bg-muted px-4 py-5 space-y-3 text-center">
                            <p className="text-sm text-muted-foreground">
                                {t("noMemberTreasuries")}
                            </p>
                            <Button
                                asChild
                                variant="secondary"
                                className="w-full"
                            >
                                <Link href="/create">
                                    {t("createTreasury")}
                                </Link>
                            </Button>
                        </div>
                    ) : (
                        <ScrollArea className={paymentSelectModalListClassName}>
                            <div className="space-y-2">
                                {memberTreasuries.map((treasury) => (
                                    <button
                                        key={treasury.daoId}
                                        type="button"
                                        onClick={() => onSelect(treasury.daoId)}
                                        className="w-full flex items-center gap-3 rounded-lg bg-muted hover:bg-general-tertiary transition-colors px-3 py-3 text-left cursor-pointer"
                                        data-testid="deposit-pay-treasury-option"
                                        data-dao-id={treasury.daoId}
                                    >
                                        <TreasuryLogo
                                            logo={
                                                treasury.config?.metadata
                                                    ?.flagLogo
                                            }
                                            isConfidential={
                                                treasury.isConfidential
                                            }
                                            alt={
                                                treasury.config?.name ||
                                                treasury.daoId
                                            }
                                            imageClassName="size-9 rounded-md"
                                            fallbackClassName="size-9 rounded-md"
                                        />
                                        <div className="flex flex-col min-w-0">
                                            <span className="text-sm font-semibold truncate">
                                                {treasury.config?.name ||
                                                    treasury.daoId}
                                            </span>
                                            <TreasuryBalance
                                                daoId={treasury.daoId}
                                                isConfidential={
                                                    treasury.isConfidential
                                                }
                                                className="text-xs"
                                                skeletonClassName="h-3 w-16"
                                            />
                                        </div>
                                    </button>
                                ))}
                            </div>
                        </ScrollArea>
                    )}
                </div>
            </PaymentSelectModalContent>
        </Dialog>
    );
}
