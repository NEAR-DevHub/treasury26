"use client";

import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useFormatDate } from "@/components/formatted-date";
import { Skeleton } from "@/components/ui/skeleton";
import { getApproversAndThreshold } from "@/lib/config-utils";
import type { Proposal, Vote } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";
import type { useProposalDetails } from "../../hooks/use-proposal-details";
import {
    ProposalStatusPill,
    statusPillClassName,
} from "../proposal-status-pill";
import { DetailsCard, RequestParty } from "./primitives";

/** How far along the workflow a marker is — the rail is tinted to match. */
type Tone = "success" | "muted" | "destructive";

const TONE_CLASS = {
    success: "bg-general-success-foreground",
    muted: "bg-general-border",
    destructive: "bg-general-destructive-foreground",
} as const satisfies Record<Tone, string>;

/**
 * The vertical line down the left of the workflow. `above: "offset"` starts the
 * rail at the first row rather than running it off the top of the card, and
 * `below: "none"` ends it at the last.
 */
function Rail({
    dot,
    above,
    below,
}: {
    dot?: Tone;
    above: Tone | "offset";
    below: Tone | "none";
}) {
    return (
        <div className="flex w-8 shrink-0 flex-col items-center self-stretch">
            {above === "offset" ? (
                <div className="h-[18px] shrink-0" />
            ) : (
                <div className={cn("w-px flex-1", TONE_CLASS[above])} />
            )}
            {dot && (
                <div
                    className={cn(
                        "size-2 shrink-0 rounded-full",
                        TONE_CLASS[dot],
                    )}
                />
            )}
            {below === "none" ? (
                <div className="flex-1" />
            ) : (
                <div className={cn("w-px flex-1", TONE_CLASS[below])} />
            )}
        </div>
    );
}

/** A milestone on the workflow: a headline and the date it carries. */
function Step({
    dot,
    above,
    below,
    title,
    subtitle,
    isSubtitleLoading = false,
}: {
    dot: Tone;
    above: Tone | "offset";
    below: Tone | "none";
    title: string;
    subtitle: string;
    isSubtitleLoading?: boolean;
}) {
    return (
        <div className="flex w-full items-center">
            <Rail dot={dot} above={above} below={below} />
            <div className="flex min-w-0 flex-1 flex-col justify-center px-2 py-2">
                <span className="text-sm font-semibold leading-[1.5]">
                    {title}
                </span>
                {isSubtitleLoading ? (
                    <Skeleton className="my-0.5 h-4 w-36" />
                ) : (
                    <span className="text-sm font-medium leading-[1.5] text-general-secondary-foreground">
                        {subtitle}
                    </span>
                )}
            </div>
        </div>
    );
}

/** An account hanging off the rail, optionally with the vote it cast. */
function Party({
    above,
    below,
    accountId,
    badge,
}: {
    above: Tone;
    below: Tone | "none";
    accountId: string;
    badge?: ReactNode;
}) {
    return (
        <div className="flex w-full items-center pr-2">
            <Rail above={above} below={below} />
            <div className="flex min-w-0 flex-1 items-center gap-1.5 py-2 pl-2">
                <RequestParty accountId={accountId} />
                {badge && <div className="ml-auto shrink-0">{badge}</div>}
            </div>
        </div>
    );
}

function VoteBadge({ vote }: { vote: Vote }) {
    const t = useTranslations("proposals.status");
    switch (vote) {
        case "Approve":
            return (
                <span className={statusPillClassName("Approved")}>
                    {t("approved")}
                </span>
            );
        case "Reject":
            return (
                <span className={statusPillClassName("Rejected")}>
                    {t("rejected")}
                </span>
            );
        case "Remove":
            return (
                <span className={statusPillClassName("Removed")}>
                    {t("removed")}
                </span>
            );
    }
}

interface ApprovalWorkflowProps {
    proposal: Proposal;
    policy: Policy;
    details: ReturnType<typeof useProposalDetails>;
}

/**
 * The life of a request read top to bottom: raised, voted on, and settled.
 * Steps the request has reached are joined by a green rail; the ones ahead of
 * it are greyed out.
 */
export function ApprovalWorkflow({
    proposal,
    policy,
    details,
}: ApprovalWorkflowProps) {
    const t = useTranslations("proposals.expanded");
    const tStatus = useTranslations("proposals.status");
    const tCommon = useTranslations("common");
    const formatDate = useFormatDate();
    const { accountId } = useNear();
    const { status, createdAt, timestamp, expiresAt, isDateLoading } = details;

    const votes = Object.entries(proposal.votes);
    const approvalsReceived = votes.filter(
        ([, vote]) => vote === "Approve",
    ).length;
    const { requiredVotes } = getApproversAndThreshold(
        policy,
        accountId ?? "",
        proposal.kind,
        false,
    );

    // Voting is "reached" once the request stops waiting on it — an expired
    // request never got there, so its rail stays grey from that point down.
    const isUnresolved = status === "Pending" || status === "Expired";
    const votingTone: Tone = isUnresolved ? "muted" : "success";

    let outcomeTone: Tone;
    let outcomeTitle: string;
    switch (status) {
        case "Pending":
            outcomeTone = "muted";
            outcomeTitle = t("expiresAt");
            break;
        case "Expired":
            outcomeTone = "muted";
            outcomeTitle = t("expiredAt");
            break;
        case "Executed":
            outcomeTone = "success";
            outcomeTitle = tStatus("executed");
            break;
        case "Rejected":
            outcomeTone = "destructive";
            outcomeTitle = tStatus("rejected");
            break;
        case "Removed":
            outcomeTone = "destructive";
            outcomeTitle = tStatus("removed");
            break;
        default:
            outcomeTone = "destructive";
            outcomeTitle = tStatus("failed");
    }

    const outcomeDate = timestamp
        ? formatDate(timestamp)
        : isUnresolved
          ? formatDate(expiresAt)
          : tCommon("notAvailable");

    return (
        <DetailsCard className="flex flex-col p-2">
            <header className="flex items-center gap-2.5 p-2">
                <h3 className="flex-1 text-base font-semibold leading-[1.2]">
                    {t("approvalWorkflow")}
                </h3>
                <ProposalStatusPill proposal={proposal} policy={policy} />
            </header>

            <Step
                dot="success"
                above="offset"
                below="success"
                title={t("transactionCreated")}
                subtitle={formatDate(createdAt)}
            />
            <Party
                above="success"
                below="success"
                accountId={proposal.proposer}
            />
            <Step
                dot={votingTone}
                above="success"
                below={votingTone}
                title={t("approvals")}
                subtitle={t("approvalsReceived", {
                    received: approvalsReceived,
                    required: requiredVotes,
                })}
            />
            {votes.map(([voter, vote]) => (
                <Party
                    key={voter}
                    above={votingTone}
                    below={votingTone}
                    accountId={voter}
                    badge={<VoteBadge vote={vote} />}
                />
            ))}
            <Step
                dot={outcomeTone}
                above={votingTone}
                below="none"
                title={outcomeTitle}
                subtitle={outcomeDate}
                isSubtitleLoading={isDateLoading}
            />
        </DetailsCard>
    );
}
