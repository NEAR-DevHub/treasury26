import {
    ArrowDown01Icon,
    ArrowRight01Icon,
    ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Alert, AlertDescription } from "@/components/alert";
import { Button } from "@/components/button";
import { FormattedDate } from "@/components/formatted-date";
import { Icon } from "@/components/icon";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Skeleton } from "@/components/ui/skeleton";
import { ProposalTypeIcon } from "@/features/proposals/components/proposal-type-icon";
import { TransactionCell } from "@/features/proposals/components/transaction-cell";
import { useProposalKindLabel } from "@/features/proposals/hooks/use-proposal-kind-label";
import {
    getProposalUIKind,
    getQuoteDeadlineMs,
} from "@/features/proposals/utils/proposal-utils";
import { useTreasury } from "@/hooks/use-treasury";
import type { Proposal } from "@/lib/proposals-api";
import { nanosToMs } from "@/lib/utils";
import type { Policy } from "@/types/policy";

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
        return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    };

    const remainingActive = impactedProposals
        .filter((p) => p.willReactivate || p.willRemainActive)
        .map(({ proposal, newExpiryDate }) => {
            const daysLeft = formatDays(newExpiryDate);
            return {
                proposal,
                newExpiry:
                    daysLeft > 0
                        ? t("expireInDays", { count: daysLeft })
                        : t("today"),
            };
        });
    const newlyExpiring = impactedProposals
        .filter((p) => p.isNewlyExpiring)
        .map(({ proposal }) => ({
            proposal,
            newExpiry: t("uponApproval"),
        }));

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="sm:max-w-3xl! max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle>{t("impactTitle")}</DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <p className="text-sm text-foreground">{t("impactBody")}</p>

                    {isLoadingProposals ? (
                        <ImpactSkeleton />
                    ) : (
                        <>
                            <Alert variant="info">
                                <AlertDescription>
                                    <ul className="list-outside list-disc space-y-1 pl-4">
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

                            {remainingActive.length > 0 && (
                                <ImpactedRequests
                                    heading={t("remainActiveHeading")}
                                    rows={remainingActive}
                                    policy={currentPolicy}
                                    treasuryId={treasuryId}
                                    isExpanded={activeExpanded}
                                    onToggle={() =>
                                        setActiveExpanded(!activeExpanded)
                                    }
                                />
                            )}

                            {newlyExpiring.length > 0 && (
                                <ImpactedRequests
                                    heading={t("willExpireHeading")}
                                    rows={newlyExpiring}
                                    policy={currentPolicy}
                                    treasuryId={treasuryId}
                                    isExpanded={expiringExpanded}
                                    onToggle={() =>
                                        setExpiringExpanded(!expiringExpanded)
                                    }
                                />
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

/** One affected request, as both layouts describe it. */
interface ImpactedRow {
    proposal: Proposal;
    /** When the request will expire once the new duration applies. */
    newExpiry: string;
}

/**
 * A group of affected requests behind a disclosure: a table on a desktop, the
 * requests list's own cards on a phone. The row leads out to the request, so
 * the reader can check one before committing to the change.
 */
function ImpactedRequests({
    heading,
    rows,
    policy,
    treasuryId,
    isExpanded,
    onToggle,
}: {
    heading: string;
    rows: ImpactedRow[];
    policy: Policy;
    treasuryId?: string;
    isExpanded: boolean;
    onToggle: () => void;
}) {
    const t = useTranslations("proposals.expanded");

    return (
        <div className="overflow-hidden rounded-xl border border-general-border">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={isExpanded}
                className="flex w-full items-center gap-2 p-3 text-left transition-colors hover:bg-general-bg-secondary/50"
            >
                <Icon
                    icon={isExpanded ? ArrowDown01Icon : ArrowRight01Icon}
                    className="size-5 shrink-0 text-general-secondary-foreground"
                />
                <span className="text-sm font-medium">{heading}</span>
            </button>

            {isExpanded && (
                <div className="border-general-border border-t">
                    {/* Desktop: the three columns the design gives the table. */}
                    <div className="hidden md:block">
                        <div className="grid grid-cols-[1fr_1fr_1fr] border-general-border border-b px-3 py-2 text-sm font-semibold text-general-secondary-foreground">
                            <div>{t("tableRequest")}</div>
                            <div>{t("tableTransaction")}</div>
                            <div>{t("tableNewExpiry")}</div>
                        </div>
                        {rows.map(({ proposal, newExpiry }) => (
                            <div
                                key={proposal.id}
                                className="grid grid-cols-[1fr_1fr_1fr] items-center gap-4 border-general-border border-b px-3 py-3 last:border-b-0"
                            >
                                <ImpactedRequestSummary
                                    proposal={proposal}
                                    policy={policy}
                                    treasuryId={treasuryId}
                                />
                                <div className="min-w-0">
                                    <TransactionCell proposal={proposal} />
                                </div>
                                <div className="flex min-w-0 items-center justify-between gap-2">
                                    <span className="truncate text-sm">
                                        {newExpiry}
                                    </span>
                                    <RequestLink
                                        treasuryId={treasuryId}
                                        proposalId={proposal.id}
                                    />
                                </div>
                            </div>
                        ))}
                    </div>

                    {/* Phone: one card per request, the way the list shows it. */}
                    <div className="flex flex-col gap-3 p-3 md:hidden">
                        {rows.map(({ proposal, newExpiry }) => (
                            <div
                                key={proposal.id}
                                className="flex flex-col gap-3 rounded-xl border border-general-border p-3"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <ImpactedRequestSummary
                                        proposal={proposal}
                                        policy={policy}
                                        treasuryId={treasuryId}
                                    />
                                    <RequestLink
                                        treasuryId={treasuryId}
                                        proposalId={proposal.id}
                                    />
                                </div>
                                <TransactionCell proposal={proposal} />
                                <span className="border-general-border border-t pt-3 text-sm text-general-secondary-foreground">
                                    {t("tableNewExpiry")}: {newExpiry}
                                </span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
}

/** The request's id, type icon and name — the table's leading column. */
function ImpactedRequestSummary({
    proposal,
    policy,
    treasuryId,
}: {
    proposal: Proposal;
    policy: Policy;
    treasuryId?: string;
}) {
    const getProposalKindLabel = useProposalKindLabel();

    return (
        <div className="flex min-w-0 items-center gap-3">
            <span className="shrink-0 text-sm font-semibold text-general-secondary-foreground">
                #{proposal.id}
            </span>
            <ProposalTypeIcon proposal={proposal} treasuryId={treasuryId} />
            <div className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-semibold">
                    {getProposalKindLabel(getProposalUIKind(proposal))}
                </span>
                <FormattedDate
                    proposal={proposal}
                    policy={policy}
                    relative
                    className="truncate text-sm text-general-secondary-foreground"
                />
            </div>
        </div>
    );
}

function RequestLink({
    treasuryId,
    proposalId,
}: {
    treasuryId?: string;
    proposalId: number;
}) {
    const t = useTranslations("proposals.expanded");

    return (
        <Button
            asChild
            variant="ghost"
            size="icon"
            tooltipContent={t("openRequestPage")}
        >
            <Link
                href={`/${treasuryId}/requests/${proposalId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
            >
                <Icon icon={ArrowUpRight01Icon} />
            </Link>
        </Button>
    );
}

function ImpactSkeleton() {
    return (
        <div className="overflow-hidden rounded-xl border border-general-border">
            <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 border-general-border border-b px-3 py-2">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
            </div>
            {Array.from({ length: 3 }).map((_, i) => (
                <div
                    // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list
                    key={i}
                    className="grid grid-cols-[1fr_1fr_1fr] items-center gap-4 border-general-border border-b px-3 py-3 last:border-b-0"
                >
                    <div className="flex items-center gap-3">
                        <Skeleton className="h-4 w-6 shrink-0" />
                        <Skeleton className="size-9 shrink-0 rounded-full" />
                        <div className="flex flex-1 flex-col gap-1.5">
                            <Skeleton className="h-4 w-24" />
                            <Skeleton className="h-3 w-16" />
                        </div>
                    </div>
                    <div className="flex flex-col gap-1.5">
                        <Skeleton className="h-4 w-28" />
                        <Skeleton className="h-3 w-20" />
                    </div>
                    <Skeleton className="h-4 w-16" />
                </div>
            ))}
        </div>
    );
}
