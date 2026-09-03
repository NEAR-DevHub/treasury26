"use client";

import {
    ArrowExpandDiagonal01Icon,
    Cancel01Icon,
    Delete01Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { Icon } from "@/components/icon";
import {
    SideSheet,
    SideSheetBody,
    SideSheetClose,
    SideSheetContent,
    SideSheetFooter,
    SideSheetHeader,
} from "@/components/side-sheet";
import { useTreasury } from "@/hooks/use-treasury";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";
import { useProposalDetails } from "../../hooks/use-proposal-details";
import { ApprovalWorkflow } from "./approval-workflow";
import {
    REQUEST_ACTION_ROW_CLASS,
    RequestDetailsBody,
    RequestNotices,
    useRequestActions,
} from "./request-details-content";

/** 28px ghost squares, the tray of actions the design gives the title bar. */
const HEADER_ACTION_CLASS =
    "size-7 rounded-sm p-1 text-general-secondary-foreground [&_svg]:size-[13.25px]";

interface RequestDetailsSheetProps {
    /** The request to describe; `null` closes the sheet. */
    proposal: Proposal | null;
    policy: Policy;
    onOpenChange: (open: boolean) => void;
    onVote: (proposal: Proposal, vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

export function RequestDetailsSheet({
    proposal,
    policy,
    onOpenChange,
    onVote,
    onDeposit,
}: RequestDetailsSheetProps) {
    return (
        <SideSheet open={!!proposal} onOpenChange={onOpenChange}>
            <SideSheetContent>
                {/* Remounting per request keeps every derived query keyed to
                    the one on screen instead of leaking the previous one. */}
                {proposal && (
                    <RequestDetails
                        key={proposal.id}
                        proposal={proposal}
                        policy={policy}
                        onVote={(vote) => onVote(proposal, vote)}
                        onDeposit={onDeposit}
                    />
                )}
            </SideSheetContent>
        </SideSheet>
    );
}

function RequestDetails({
    proposal,
    policy,
    onVote,
    onDeposit,
}: {
    proposal: Proposal;
    policy: Policy;
    onVote: (vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}) {
    const t = useTranslations("proposals.expanded");
    const tCommon = useTranslations("common");
    const { treasuryId } = useTreasury();
    const { accountId } = useNear();
    const details = useProposalDetails(proposal, policy);
    const actions = useRequestActions({
        proposal,
        policy,
        details,
        onVote,
        onDeposit,
    });

    const isOwnPendingProposal =
        proposal.proposer === accountId && details.isPending;
    const hasVoted = !!proposal.votes[accountId ?? ""];
    const requestUrl = `/${treasuryId}/requests/${proposal.id}`;

    return (
        <>
            <SideSheetHeader
                title={t("details")}
                actions={
                    <>
                        {isOwnPendingProposal && !hasVoted && (
                            <Button
                                variant="ghost"
                                className={HEADER_ACTION_CLASS}
                                tooltipContent={t("deleteRequest")}
                                onClick={() => onVote("Remove")}
                            >
                                <Icon icon={Delete01Icon} />
                            </Button>
                        )}
                        <CopyButton
                            variant="ghost"
                            className={HEADER_ACTION_CLASS}
                            text={`${window.location.origin}${requestUrl}`}
                            tooltipContent={t("copyLink")}
                        />
                        <Button
                            asChild
                            variant="ghost"
                            className={HEADER_ACTION_CLASS}
                            tooltipContent={t("openRequestPage")}
                        >
                            <Link
                                href={requestUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <Icon icon={ArrowExpandDiagonal01Icon} />
                            </Link>
                        </Button>
                        <SideSheetClose asChild>
                            <Button
                                variant="ghost"
                                className={HEADER_ACTION_CLASS}
                                aria-label={tCommon("close")}
                            >
                                <Icon icon={Cancel01Icon} />
                            </Button>
                        </SideSheetClose>
                    </>
                }
            />

            <SideSheetBody>
                <RequestDetailsBody proposal={proposal} details={details} />
                <ApprovalWorkflow
                    proposal={proposal}
                    policy={policy}
                    details={details}
                />
                <RequestNotices proposal={proposal} details={details} />
            </SideSheetBody>

            {actions && (
                <SideSheetFooter
                    className={cn(REQUEST_ACTION_ROW_CLASS, "gap-3")}
                >
                    {actions}
                </SideSheetFooter>
            )}
        </>
    );
}
