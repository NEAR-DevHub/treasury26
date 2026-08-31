"use client";

import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { HighlightedText } from "@/components/highlighted-text";
import { Icon } from "@/components/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { useTreasury } from "@/hooks/use-treasury";
import type { Proposal } from "@/lib/proposals-api";
import type { Policy } from "@/types/policy";
import { useProposalKindLabel } from "../hooks/use-proposal-kind-label";
import { extractConfidentialRequestData } from "../utils/proposal-extractors";
import { getProposalUIKind } from "../utils/proposal-utils";
import { ProposalStatusPill } from "./proposal-status-pill";
import { ProposalTimelineDate } from "./proposal-timeline-date";
import { ProposalTypeIcon } from "./proposal-type-icon";
import { TransactionCell } from "./transaction-cell";
import { VotingIndicator } from "./voting-indicator";

interface ProposalCardProps {
    proposal: Proposal;
    policy: Policy;
    /** Active requests search query — used to highlight matching text. */
    searchQuery?: string;
    onOpen: (proposal: Proposal) => void;
}

/**
 * A request as a phone-sized card: the table's columns restacked into a summary
 * over a footer that keeps the approvals badge and the status pill on one line.
 * The table's checkbox and requester columns are dropped — bulk voting is a
 * desktop affordance, and the requester lives on the request page.
 */
export function ProposalCard({
    proposal,
    policy,
    searchQuery = "",
    onOpen,
}: ProposalCardProps) {
    const tActions = useTranslations("requests.actions");
    const { treasuryId } = useTreasury();
    const getProposalKindLabel = useProposalKindLabel();
    const kind = getProposalUIKind(proposal);
    const title =
        kind === "Confidential Request"
            ? extractConfidentialRequestData(proposal, treasuryId).title
            : getProposalKindLabel(kind);

    return (
        <div className="relative flex w-full flex-col rounded-3xl border border-general-border bg-card px-3">
            <div className="flex w-full items-start gap-2 py-3">
                <ProposalTypeIcon proposal={proposal} treasuryId={treasuryId} />
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <HighlightedText
                        text={title}
                        query={searchQuery}
                        className="max-w-full truncate font-bold leading-4"
                    />
                    <TransactionCell
                        proposal={proposal}
                        textOnly
                        inlineSwap
                        subtitleSuffix={
                            <ProposalTimelineDate
                                proposal={proposal}
                                policy={policy}
                            />
                        }
                    />
                </div>
                {/* The chevron is where the affordance shows, but the whole
                    summary is the tap target: the overlay stretches this button
                    across the card, under the footer's own controls. */}
                <button
                    type="button"
                    onClick={() => onOpen(proposal)}
                    aria-label={tActions("viewRequest")}
                    className="flex size-9 shrink-0 items-center justify-center after:absolute after:inset-0 after:rounded-3xl"
                >
                    <Icon
                        icon={ArrowRight01Icon}
                        className="text-muted-foreground"
                    />
                </button>
            </div>

            <span className="h-px w-full bg-general-border" />

            <div className="relative flex w-full items-center justify-between py-4">
                <VotingIndicator proposal={proposal} policy={policy} />
                <ProposalStatusPill proposal={proposal} policy={policy} />
            </div>
        </div>
    );
}

/** A card-shaped placeholder, so the phone list doesn't load as a wide table. */
export function ProposalCardSkeleton() {
    return <Skeleton className="h-[146px] w-full rounded-3xl" />;
}
