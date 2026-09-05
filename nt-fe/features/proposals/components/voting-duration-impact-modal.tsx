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
import { Icon } from "@/components/icon";
import {
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    mobileInsetSheetClassName,
} from "@/components/modal";
import { sheetCellClassName } from "@/components/table-sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ProposalCard } from "@/features/proposals/components/proposal-card";
import { ProposalTimelineDate } from "@/features/proposals/components/proposal-timeline-date";
import { ProposalTypeIcon } from "@/features/proposals/components/proposal-type-icon";
import { HEAD_CLASS } from "@/features/proposals/components/proposals-table-layout";
import { TransactionCell } from "@/features/proposals/components/transaction-cell";
import { useProposalKindLabel } from "@/features/proposals/hooks/use-proposal-kind-label";
import { extractConfidentialRequestData } from "@/features/proposals/utils/proposal-extractors";
import {
    getProposalUIKind,
    getQuoteDeadlineMs,
} from "@/features/proposals/utils/proposal-utils";
import { useTreasury } from "@/hooks/use-treasury";
import type { Proposal } from "@/lib/proposals-api";
import { cn, nanosToMs } from "@/lib/utils";
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
            <DialogContent
                className={cn(
                    "gap-3 overflow-y-hidden p-4 sm:max-w-[720px]! sm:gap-4 sm:p-5",
                    "max-sm:max-h-[min(75vh,600px)]",
                    mobileInsetSheetClassName,
                )}
            >
                <DialogHeader className="mx-0 shrink-0 border-0 px-0 pb-0">
                    <DialogTitle className="text-left text-base leading-[1.2]">
                        {t("impactTitle")}
                    </DialogTitle>
                </DialogHeader>

                <div className="-mx-4 flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 scrollbar-hide [&>*]:shrink-0 sm:-mx-5 sm:gap-4 sm:px-5">
                    <p className="text-sm font-medium text-general-secondary-foreground">
                        {t("impactBody")}
                    </p>

                    {isLoadingProposals ? (
                        <ImpactSkeleton />
                    ) : (
                        <>
                            <Alert variant="info" className="p-3">
                                <AlertDescription>
                                    <ul className="list-outside list-disc space-y-1 pl-4 font-medium">
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

                <DialogFooter className="-mx-4 border-general-border border-t px-4 pt-3 max-sm:mt-2 sm:-mx-5 sm:px-5">
                    <Button
                        onClick={onConfirm}
                        size="xl"
                        className="w-full rounded-xl max-sm:h-10 max-sm:rounded-lg max-sm:text-sm"
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
        <div className="overflow-hidden rounded-2xl border border-general-border bg-general-tertiary">
            <button
                type="button"
                onClick={onToggle}
                aria-expanded={isExpanded}
                className="flex w-full items-center gap-2 p-3 text-left text-sm font-medium text-general-secondary-foreground transition-colors hover:bg-general-border/40"
            >
                <Icon
                    icon={isExpanded ? ArrowDown01Icon : ArrowRight01Icon}
                    className="size-5 shrink-0"
                />
                <span>{heading}</span>
            </button>

            {isExpanded && (
                <>
                    {/* Desktop: the sheet the requests table floats its rows in. */}
                    <div className="hidden px-1 pb-1 lg:block">
                        <table className="w-full table-fixed border-separate border-spacing-0">
                            <thead>
                                <tr>
                                    <th
                                        className={cn(
                                            HEAD_CLASS,
                                            "px-3 text-left",
                                        )}
                                    >
                                        {t("tableRequest")}
                                    </th>
                                    <th
                                        className={cn(
                                            HEAD_CLASS,
                                            "px-4 text-left",
                                        )}
                                    >
                                        {t("tableTransaction")}
                                    </th>
                                    <th
                                        className={cn(
                                            HEAD_CLASS,
                                            "px-3 text-left",
                                        )}
                                    >
                                        {t("tableNewExpiry")}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map(({ proposal, newExpiry }, index) => {
                                    const cellClass = (
                                        column: number,
                                        padding: string,
                                    ) =>
                                        cn(
                                            "h-[66px]",
                                            sheetCellClassName({
                                                isFirstRow: index === 0,
                                                isLastRow:
                                                    index === rows.length - 1,
                                                isFirstColumn: column === 0,
                                                isLastColumn: column === 2,
                                            }),
                                            padding,
                                        );
                                    return (
                                        <tr key={proposal.id}>
                                            <td
                                                className={cellClass(0, "px-3")}
                                            >
                                                <ImpactedRequestSummary
                                                    proposal={proposal}
                                                    policy={policy}
                                                    treasuryId={treasuryId}
                                                />
                                            </td>
                                            <td
                                                className={cellClass(1, "px-4")}
                                            >
                                                <TransactionCell
                                                    proposal={proposal}
                                                />
                                            </td>
                                            <td
                                                className={cellClass(2, "px-3")}
                                            >
                                                <div className="flex min-w-0 items-center justify-between gap-2">
                                                    <span className="truncate text-sm font-semibold">
                                                        {newExpiry}
                                                    </span>
                                                    <RequestLink
                                                        treasuryId={treasuryId}
                                                        proposalId={proposal.id}
                                                        icon={
                                                            ArrowUpRight01Icon
                                                        }
                                                    />
                                                </div>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>

                    {/* Phone: one card per request, the way the list shows it. */}
                    <div className="flex flex-col gap-2 px-1 pb-1 lg:hidden">
                        {rows.map(({ proposal, newExpiry }) => (
                            <ProposalCard
                                key={proposal.id}
                                proposal={proposal}
                                policy={policy}
                                className="rounded-xl"
                                onOpen={() =>
                                    window.open(
                                        `/${treasuryId}/requests/${proposal.id}`,
                                        "_blank",
                                        "noopener,noreferrer",
                                    )
                                }
                                footer={
                                    <span className="text-sm text-general-secondary-foreground">
                                        {t("tableNewExpiry")}: {newExpiry}
                                    </span>
                                }
                            />
                        ))}
                    </div>
                </>
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
    const kind = getProposalUIKind(proposal);
    const title =
        kind === "Confidential Request"
            ? extractConfidentialRequestData(proposal, treasuryId).title
            : getProposalKindLabel(kind);

    return (
        <div className="flex min-w-0 items-center gap-2">
            <span className="shrink-0 text-sm font-medium text-general-secondary-foreground">
                #{proposal.id}
            </span>
            <ProposalTypeIcon proposal={proposal} treasuryId={treasuryId} />
            <div className="flex min-w-0 flex-col items-start">
                <span className="max-w-full truncate text-sm font-semibold">
                    {title}
                </span>
                <ProposalTimelineDate
                    proposal={proposal}
                    policy={policy}
                    className="truncate text-sm font-medium text-general-secondary-foreground"
                />
            </div>
        </div>
    );
}

function RequestLink({
    treasuryId,
    proposalId,
    icon,
}: {
    treasuryId?: string;
    proposalId: number;
    icon: React.ComponentProps<typeof Icon>["icon"];
}) {
    const t = useTranslations("proposals.expanded");

    return (
        <Button
            asChild
            variant="ghost"
            size="icon"
            className="size-10 shrink-0 text-general-secondary-foreground"
            tooltipContent={t("openRequestPage")}
        >
            <Link
                href={`/${treasuryId}/requests/${proposalId}`}
                target="_blank"
                rel="noopener noreferrer"
                onClick={(e) => e.stopPropagation()}
            >
                <Icon icon={icon} />
            </Link>
        </Button>
    );
}

function ImpactSkeleton() {
    return (
        <div className="rounded-2xl border border-general-border bg-general-tertiary p-1">
            <div className="grid grid-cols-[1fr_1fr_1fr] gap-4 px-3 py-3">
                <Skeleton className="h-3 w-16" />
                <Skeleton className="h-3 w-20" />
                <Skeleton className="h-3 w-16" />
            </div>
            <div className="overflow-hidden rounded-xl border border-general-border bg-card">
                {Array.from({ length: 3 }).map((_, i) => (
                    <div
                        // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder list
                        key={i}
                        className="grid grid-cols-[1fr_1fr_1fr] items-center gap-4 border-general-border border-b px-3 py-3 last:border-b-0"
                    >
                        <div className="flex items-center gap-2">
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
        </div>
    );
}
