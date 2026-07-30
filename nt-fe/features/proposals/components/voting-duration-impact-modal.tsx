import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogFooter,
} from "@/components/modal";
import { Button } from "@/components/button";
import { ChevronDown, ChevronRight, ArrowUpRight } from "lucide-react";
import { useTranslations } from "next-intl";
import { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useTreasury } from "@/hooks/use-treasury";
import { Skeleton } from "@/components/ui/skeleton";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { Alert, AlertDescription } from "@/components/alert";
import { ProposalTypeIcon } from "@/features/proposals/components/proposal-type-icon";
import { TransactionCell } from "@/features/proposals/components/transaction-cell";
import {
    getQuoteDeadlineMs,
    getProposalUIKind,
} from "@/features/proposals/utils/proposal-utils";
import { useProposalKindLabel } from "@/features/proposals/hooks/use-proposal-kind-label";
import { FormattedDate } from "@/components/formatted-date";
import { nanosToMs } from "@/lib/utils";

interface VotingDurationImpactModalProps {
    isOpen: boolean;
    onClose: () => void;
    onConfirm: () => void;
    onNoImpactedProposals?: () => void;
    newDurationDays: number;
    currentPolicy: Policy;
    activeProposals: Proposal[];
    isLoadingProposals?: boolean;
}

interface ProposalImpact {
    proposal: Proposal;
    oldExpiryDate: Date;
    newExpiryDate: Date;
    wasExpiredBefore: boolean;
    willBeExpiredAfter: boolean;
    willReactivate: boolean;
    willRemainActive: boolean;
    isNewlyExpiring: boolean;
}

export function VotingDurationImpactModal({
    isOpen,
    onClose,
    onConfirm,
    onNoImpactedProposals,
    newDurationDays,
    currentPolicy,
    activeProposals,
    isLoadingProposals = false,
}: VotingDurationImpactModalProps) {
    const t = useTranslations("proposals.expanded");
    const getProposalKindLabel = useProposalKindLabel();
    const { treasuryId } = useTreasury();
    const [activeExpanded, setActiveExpanded] = useState(false);
    const [expiringExpanded, setExpiringExpanded] = useState(false);

    // Calculate impact on proposals
    const impactedProposals = useMemo(() => {
        const now = Date.now();
        const newDurationMs = newDurationDays * 24 * 60 * 60 * 1000;
        const currentDurationMs = nanosToMs(currentPolicy.proposal_period);

        return activeProposals
            .map((proposal): ProposalImpact => {
                const submissionTimeMs = nanosToMs(proposal.submission_time);
                const quoteDeadlineMs = getQuoteDeadlineMs(proposal);
                const cappedExpiry = (periodMs: number) => {
                    const byPeriod = submissionTimeMs + periodMs;
                    return quoteDeadlineMs === undefined
                        ? byPeriod
                        : Math.min(byPeriod, quoteDeadlineMs);
                };
                const oldExpiryDate = new Date(cappedExpiry(currentDurationMs));
                const newExpiryDate = new Date(cappedExpiry(newDurationMs));

                const wasExpiredBefore = oldExpiryDate.getTime() <= now;
                const willBeExpiredAfter = newExpiryDate.getTime() <= now;
                const willReactivate = wasExpiredBefore && !willBeExpiredAfter;
                const willRemainActive =
                    !wasExpiredBefore && !willBeExpiredAfter;
                const isNewlyExpiring = !wasExpiredBefore && willBeExpiredAfter;

                return {
                    proposal,
                    oldExpiryDate,
                    newExpiryDate,
                    wasExpiredBefore,
                    willBeExpiredAfter,
                    willReactivate,
                    willRemainActive,
                    isNewlyExpiring,
                };
            })
            .filter(
                (p) =>
                    p.oldExpiryDate.getTime() !== p.newExpiryDate.getTime() &&
                    (p.willReactivate ||
                        p.willRemainActive ||
                        p.isNewlyExpiring),
            )
            .sort((a, b) => {
                // Show active outcomes first, expiring outcomes second
                if (a.willBeExpiredAfter !== b.willBeExpiredAfter) {
                    return a.willBeExpiredAfter ? 1 : -1;
                }
                return b.proposal.id - a.proposal.id;
            });
    }, [activeProposals, newDurationDays, currentPolicy]);

    const activeProposalsCount = impactedProposals.filter(
        (p) => p.willReactivate || p.willRemainActive,
    ).length;
    const expiringProposalsCount = impactedProposals.filter(
        (p) => p.isNewlyExpiring,
    ).length;

    useEffect(() => {
        if (!isOpen || isLoadingProposals) return;
        if (impactedProposals.length > 0) return;
        onClose();
        onNoImpactedProposals?.();
    }, [
        isOpen,
        isLoadingProposals,
        impactedProposals.length,
        onClose,
        onNoImpactedProposals,
    ]);

    const formatDays = (date: Date) => {
        const now = new Date();
        const diffMs = date.getTime() - now.getTime();
        const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
        return diffDays;
    };

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-3xl! max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t("impactTitle")}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
                    <p className="text-sm text-foreground">{t("impactBody")}</p>

                    {isLoadingProposals && (
                        <div className="border rounded-lg overflow-hidden">
                            <div className="grid grid-cols-[1fr_1fr_140px] gap-4 px-4 py-2 bg-general-tertiary border-b">
                                <Skeleton className="h-3 w-16" />
                                <Skeleton className="h-3 w-20" />
                                <Skeleton className="h-3 w-16" />
                            </div>
                            {Array.from({ length: 3 }).map((_, i) => (
                                <div
                                    key={i}
                                    className="grid grid-cols-[1fr_1fr_140px] gap-4 px-4 py-3 border-b items-center"
                                >
                                    <div className="flex items-center gap-3">
                                        <Skeleton className="h-4 w-6 shrink-0" />
                                        <Skeleton className="h-8 w-8 rounded-lg shrink-0" />
                                        <div className="space-y-1.5 flex-1">
                                            <Skeleton className="h-4 w-24" />
                                            <Skeleton className="h-3 w-16" />
                                        </div>
                                    </div>
                                    <div className="space-y-1.5">
                                        <Skeleton className="h-4 w-28" />
                                        <Skeleton className="h-3 w-20" />
                                    </div>
                                    <Skeleton className="h-4 w-16" />
                                </div>
                            ))}
                        </div>
                    )}

                    {!isLoadingProposals && (
                        <>
                            <Alert variant="info">
                                <AlertDescription>
                                    <ul className="list-disc list-outside pl-4 space-y-1">
                                        {activeProposalsCount > 0 && (
                                            <li>
                                                {t("activeRequestsBullet", {
                                                    count: activeProposalsCount,
                                                })}
                                            </li>
                                        )}
                                        {expiringProposalsCount > 0 && (
                                            <li>
                                                {t("expiringRequestsBullet", {
                                                    count: expiringProposalsCount,
                                                })}
                                            </li>
                                        )}
                                    </ul>
                                </AlertDescription>
                            </Alert>

                            {/* Active Requests */}
                            {activeProposalsCount > 0 && (
                                <div className="border rounded-lg overflow-hidden">
                                    <button
                                        onClick={() =>
                                            setActiveExpanded(!activeExpanded)
                                        }
                                        className="w-full flex items-center p-4 hover:bg-muted/50 transition-colors"
                                    >
                                        <div className="flex items-center gap-2">
                                            {activeExpanded ? (
                                                <ChevronDown className="h-4 w-4" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4" />
                                            )}
                                            <span className="text-sm text-left">
                                                {t("remainActiveHeading")}
                                            </span>
                                        </div>
                                    </button>

                                    {activeExpanded && (
                                        <div className="border-t">
                                            {/* Header */}
                                            <div className="grid grid-cols-[1fr_1fr_140px] gap-4 px-4 py-2 bg-general-tertiary border-b text-xs font-medium uppercase text-muted-foreground">
                                                <div>{t("tableRequest")}</div>
                                                <div>
                                                    {t("tableTransaction")}
                                                </div>
                                                <div>{t("tableNewExpiry")}</div>
                                            </div>

                                            {/* Rows */}
                                            {impactedProposals
                                                .filter(
                                                    (p) =>
                                                        p.willReactivate ||
                                                        p.willRemainActive,
                                                )
                                                .map(
                                                    ({
                                                        proposal,
                                                        newExpiryDate,
                                                    }) => {
                                                        const daysLeft =
                                                            formatDays(
                                                                newExpiryDate,
                                                            );
                                                        return (
                                                            <div
                                                                key={
                                                                    proposal.id
                                                                }
                                                                className="grid grid-cols-[1fr_1fr_140px] gap-4 px-4 py-3 border-b items-center"
                                                            >
                                                                <div className="flex items-center gap-3 min-w-0">
                                                                    <span className="text-sm font-semibold text-muted-foreground shrink-0">
                                                                        #
                                                                        {
                                                                            proposal.id
                                                                        }
                                                                    </span>
                                                                    <ProposalTypeIcon
                                                                        proposal={
                                                                            proposal
                                                                        }
                                                                        treasuryId={
                                                                            treasuryId
                                                                        }
                                                                    />
                                                                    <div className="flex flex-col min-w-0">
                                                                        <span className="text-sm font-medium truncate">
                                                                            {getProposalKindLabel(
                                                                                getProposalUIKind(
                                                                                    proposal,
                                                                                ),
                                                                            )}
                                                                        </span>
                                                                        <FormattedDate
                                                                            proposal={
                                                                                proposal
                                                                            }
                                                                            policy={
                                                                                currentPolicy
                                                                            }
                                                                            relative
                                                                            className="text-xs text-muted-foreground"
                                                                        />
                                                                    </div>
                                                                </div>

                                                                <div className="min-w-0 truncate">
                                                                    <TransactionCell
                                                                        proposal={
                                                                            proposal
                                                                        }
                                                                    />
                                                                </div>

                                                                <Link
                                                                    href={`/${treasuryId}/requests/${proposal.id}`}
                                                                    target="_blank"
                                                                    rel="noopener noreferrer"
                                                                    className="flex items-center gap-1.5 text-sm hover:underline"
                                                                    onClick={(
                                                                        e,
                                                                    ) =>
                                                                        e.stopPropagation()
                                                                    }
                                                                >
                                                                    {daysLeft >
                                                                    0
                                                                        ? t(
                                                                              "expireInDays",
                                                                              {
                                                                                  count: daysLeft,
                                                                              },
                                                                          )
                                                                        : t(
                                                                              "today",
                                                                          )}
                                                                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                                                                </Link>
                                                            </div>
                                                        );
                                                    },
                                                )}
                                        </div>
                                    )}
                                </div>
                            )}

                            {/* Expiring Requests */}
                            {expiringProposalsCount > 0 && (
                                <div className="border rounded-lg overflow-hidden">
                                    <button
                                        onClick={() =>
                                            setExpiringExpanded(
                                                !expiringExpanded,
                                            )
                                        }
                                        className="w-full flex items-center justify-between p-4 hover:bg-muted/50 transition-colors"
                                    >
                                        <div className="flex items-center gap-2">
                                            {expiringExpanded ? (
                                                <ChevronDown className="h-4 w-4" />
                                            ) : (
                                                <ChevronRight className="h-4 w-4" />
                                            )}
                                            <span className="text-sm text-left">
                                                {t("willExpireHeading")}
                                            </span>
                                        </div>
                                    </button>

                                    {expiringExpanded && (
                                        <div className="border-t">
                                            {/* Header */}
                                            <div className="grid grid-cols-[1fr_1fr_140px] gap-4 px-4 py-2 bg-general-tertiary border-b text-xs font-medium uppercase text-muted-foreground">
                                                <div>{t("tableRequest")}</div>
                                                <div>
                                                    {t("tableTransaction")}
                                                </div>
                                                <div>{t("tableNewExpiry")}</div>
                                            </div>
                                            {impactedProposals
                                                .filter(
                                                    (p) => p.isNewlyExpiring,
                                                )
                                                .map(({ proposal }) => (
                                                    <div
                                                        key={proposal.id}
                                                        className="grid grid-cols-[1fr_1fr_140px] gap-4 px-4 py-3 border-b items-center"
                                                    >
                                                        <div className="flex items-center gap-3 min-w-0">
                                                            <span className="text-sm font-semibold text-muted-foreground shrink-0">
                                                                #{proposal.id}
                                                            </span>
                                                            <ProposalTypeIcon
                                                                proposal={
                                                                    proposal
                                                                }
                                                                treasuryId={
                                                                    treasuryId
                                                                }
                                                            />
                                                            <div className="flex flex-col min-w-0">
                                                                <span className="text-sm font-medium truncate">
                                                                    {getProposalKindLabel(
                                                                        getProposalUIKind(
                                                                            proposal,
                                                                        ),
                                                                    )}
                                                                </span>
                                                                <FormattedDate
                                                                    proposal={
                                                                        proposal
                                                                    }
                                                                    policy={
                                                                        currentPolicy
                                                                    }
                                                                    relative
                                                                    className="text-xs text-muted-foreground"
                                                                />
                                                            </div>
                                                        </div>

                                                        <div className="min-w-0 truncate">
                                                            <TransactionCell
                                                                proposal={
                                                                    proposal
                                                                }
                                                            />
                                                        </div>

                                                        <Link
                                                            href={`/${treasuryId}/requests/${proposal.id}`}
                                                            target="_blank"
                                                            rel="noopener noreferrer"
                                                            className="flex items-center gap-1.5 text-sm hover:underline"
                                                            onClick={(e) =>
                                                                e.stopPropagation()
                                                            }
                                                        >
                                                            {t("uponApproval")}
                                                            <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                                                        </Link>
                                                    </div>
                                                ))}
                                        </div>
                                    )}
                                </div>
                            )}
                        </>
                    )}
                </div>

                <DialogFooter>
                    <Button
                        variant="default"
                        onClick={onConfirm}
                        className="w-full"
                    >
                        {t("yesContinue")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
