"use client";

import { useTranslations } from "next-intl";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { UIProposalStatus, getProposalStatus } from "../utils/proposal-utils";
import { Tooltip } from "@/components/tooltip";
import { Proposal, Vote } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { getApproversAndThreshold } from "@/lib/config-utils";
import { useProposalTransaction } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";

type PillStatus = UIProposalStatus | "Paid" | "Approved";

interface StatusPillProps {
    status: PillStatus;
    className?: string;
}

/** Surface, border and label for a pill — the design tints all three together. */
export function getStatusColor(status: PillStatus): string {
    switch (status) {
        case "Approved":
        case "Executed":
        case "Paid":
            return "border-general-success-border bg-general-success-background-faded text-general-success-foreground";
        case "Failed":
            return "border-general-warning-border bg-general-warning-background-faded text-general-warning-foreground";
        case "Rejected":
        case "Removed":
            return "border-general-destructive-border bg-general-destructive-background-faded text-general-destructive-foreground";
        case "Pending":
            return "border-general-orange-border bg-general-orange-background-faded text-general-orange-foreground";
        case "Expired":
            return "border-general-border bg-general-bg-secondary text-general-secondary-foreground";
        default:
            return "border-general-border bg-muted text-muted-foreground";
    }
}

function statusKey(status: PillStatus): string {
    switch (status) {
        case "Approved":
        case "Paid":
        case "Executed":
            return "executed";
        case "Pending":
            return "pending";
        case "Rejected":
            return "rejected";
        case "Expired":
            return "expired";
        case "Failed":
            return "failed";
        case "Removed":
            return "removed";
        default:
            return "pending";
    }
}

/** The pill's shape plus the tint for a status — shared with vote badges. */
export function statusPillClassName(
    status: PillStatus,
    className?: string,
): string {
    return cn(
        "inline-flex min-h-6 items-center rounded-lg border px-2 py-[3px] text-xs font-semibold",
        getStatusColor(status),
        className,
    );
}

export function StatusPill({ status, className }: StatusPillProps) {
    const t = useTranslations("proposals.status");
    return (
        <span className={statusPillClassName(status, className)}>
            {t(statusKey(status))}
        </span>
    );
}

/** The vote an account cast, tinted like the status it moves the request towards. */
export function VoteBadge({
    vote,
    className,
}: {
    vote: Vote;
    className?: string;
}) {
    const t = useTranslations("proposals.status");
    switch (vote) {
        case "Approve":
            return (
                <span className={statusPillClassName("Approved", className)}>
                    {t("approved")}
                </span>
            );
        case "Reject":
            return (
                <span className={statusPillClassName("Rejected", className)}>
                    {t("rejected")}
                </span>
            );
        case "Remove":
            return (
                <span className={statusPillClassName("Removed", className)}>
                    {t("removed")}
                </span>
            );
    }
}

interface ProposalStatusPillProps {
    proposal: Proposal;
    policy: Policy;
    className?: string;
}

/**
 * Status pill with dynamic tooltips derived from the proposal and policy.
 * Shows actual vote counts and, for Failed proposals, a transaction link.
 */
export function ProposalStatusPill({
    proposal,
    policy,
    className,
}: ProposalStatusPillProps) {
    const tTooltip = useTranslations("proposals.statusTooltip");
    const { treasuryId } = useTreasury();
    const status = getProposalStatus(proposal, policy);

    const isFailed = status === "Failed";

    const { data: transaction } = useProposalTransaction(
        treasuryId,
        proposal,
        policy,
        isFailed,
    );

    const { requiredVotes } = getApproversAndThreshold(
        policy,
        "",
        proposal.kind,
        false,
    );

    const approveCount = Object.values(proposal.votes).filter(
        (v) => v === "Approve",
    ).length;
    const rejectCount = Object.values(proposal.votes).filter(
        (v) => v === "Reject",
    ).length;

    let info: React.ReactNode | undefined;
    switch (status) {
        case "Pending":
            info = tTooltip("pending");
            break;
        case "Executed":
            info = tTooltip("executed", {
                approved: approveCount,
                required: requiredVotes,
            });
            break;
        case "Rejected":
            info = tTooltip("rejected", {
                rejected: rejectCount,
                required: requiredVotes,
            });
            break;
        case "Expired":
            info = tTooltip("expired");
            break;
        case "Failed":
            info = transaction?.nearblocks_url
                ? tTooltip.rich("failed", {
                      link: (chunks) => (
                          <Link
                              href={transaction.nearblocks_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="underline"
                          >
                              {chunks}
                          </Link>
                      ),
                  })
                : tTooltip("failedPlain");
            break;
        default:
            info = undefined;
    }

    return (
        <Tooltip content={info} triggerProps={{ asChild: false }}>
            <StatusPill status={status} className={className} />
        </Tooltip>
    );
}
