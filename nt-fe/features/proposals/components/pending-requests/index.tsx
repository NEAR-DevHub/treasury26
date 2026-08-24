import {
    ArrowDown02Icon,
    ArrowRight01Icon,
    Cancel01Icon,
    CheckIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
    AuthButtonWithProposal,
    useNoVoteMessage,
} from "@/components/auth-button";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { ConfidentialState } from "@/components/confidential-state";
import { EmptyState } from "@/components/empty-state";
import { FormattedDate } from "@/components/formatted-date";
import { Skeleton } from "@/components/ui/skeleton";
import { SlotWarning } from "@/components/warning-message";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useProposalApproveBlock } from "@/hooks/use-warnings";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import type { Policy } from "@/types/policy";
import { useProposalInsufficientBalance } from "../../hooks/use-proposal-insufficient-balance";
import { useProposalKindLabel } from "../../hooks/use-proposal-kind-label";
import { useVoteActionSlots } from "../../hooks/use-vote-action-slots";
import { extractConfidentialRequestData } from "../../utils/proposal-extractors";
import { getProposalUIKind } from "../../utils/proposal-utils";
import { NotEnoughBalance } from "../not-enough-balance";
import { ProposalTypeIcon } from "../proposal-type-icon";
import { TransactionCell } from "../transaction-cell";
import { VoteModal } from "../vote-modal";

const MAX_DISPLAYED_REQUESTS = 3;

function PendingRequestItemSkeleton({ opacity }: { opacity?: number }) {
    return (
        <PageCard
            className="flex-row items-center gap-3"
            style={opacity == null ? undefined : { opacity }}
        >
            <Skeleton className="size-9 shrink-0 rounded-full" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-1/4" />
                <Skeleton className="h-3 w-full" />
                <Skeleton className="h-3 w-1/2" />
            </div>
        </PageCard>
    );
}

function PendingRequestsGridSkeleton({
    count = MAX_DISPLAYED_REQUESTS,
    fade = false,
}: {
    count?: number;
    fade?: boolean;
}) {
    return (
        <div className="flex flex-col gap-4">
            {Array.from({ length: count }).map((_, index) => (
                <PendingRequestItemSkeleton
                    key={index}
                    opacity={fade ? Math.max(0.2, 1 - index * 0.45) : undefined}
                />
            ))}
        </div>
    );
}

function PendingRequestsEmpty() {
    const t = useTranslations("requests.pending");
    return (
        <div className="flex flex-col gap-4">
            <PendingRequestItemSkeleton />
            <EmptyState
                title={t("emptyTitle")}
                description={t("emptyDescription")}
                skeleton={<PendingRequestItemSkeleton opacity={0.2} />}
                className="py-0"
            />
        </div>
    );
}

function PendingRequestsSkeleton() {
    const t = useTranslations("requests.pending");
    return (
        <div className="flex h-fit w-full flex-col gap-3">
            <h2 className="text-nowrap font-bold text-base tracking-tight">
                {t("title")}
            </h2>
            <PendingRequestsGridSkeleton />
        </div>
    );
}

interface PendingRequestItemProps {
    proposal: Proposal;
    policy: Policy;
    treasuryId: string;
    onVote: (vote: "Approve" | "Reject") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

export function PendingRequestItem({
    proposal,
    policy,
    treasuryId,
    onVote,
    onDeposit,
}: PendingRequestItemProps) {
    const tActions = useTranslations("requests.actions");
    const noVoteMessage = useNoVoteMessage();
    const getProposalKindLabel = useProposalKindLabel();
    const type = getProposalUIKind(proposal);
    const { data: insufficientBalanceInfo } = useProposalInsufficientBalance(
        proposal,
        treasuryId,
    );
    const { accountId } = useNear();
    const isUserVoter = !!proposal.votes[accountId ?? ""];
    // Approving payment/exchange proposals is blocked while that feature has a
    // critical warning. Rejection is never blocked by feature pauses.
    const approveBlock = useProposalApproveBlock([proposal]);
    const approveBlocked = approveBlock.anyBlocked;
    const approveBlockedWarning = approveBlock.blockedWarnings[0] ?? null;
    const {
        approve: approveSlot,
        reject: rejectSlot,
        voteBannerSlot,
    } = useVoteActionSlots();
    const title = useMemo(() => {
        if (type === "Confidential Request") {
            return extractConfidentialRequestData(proposal, treasuryId).title;
        }
        return getProposalKindLabel(type);
    }, [type, proposal, treasuryId, getProposalKindLabel]);

    return (
        <Link href={`/${treasuryId}/requests/${proposal.id}`}>
            <PageCard className="group relative flex w-full flex-row justify-between gap-3.5 overflow-hidden transition-colors hover:border-gray-300">
                <ProposalTypeIcon proposal={proposal} treasuryId={treasuryId} />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <span className="max-w-full truncate leading-none font-semibold">
                        {title}
                    </span>
                    <TransactionCell
                        proposal={proposal}
                        textOnly
                        subtitleSuffix={
                            <FormattedDate
                                proposal={proposal}
                                policy={policy}
                                relative
                                className="text-xs text-muted-foreground"
                            />
                        }
                    />
                    <div className="gap-3 grid grid-rows-[1fr] sm:grid-rows-[0fr] pt-4 w-full sm:group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-in-out">
                        <div className="overflow-hidden w-full flex flex-col gap-2">
                            <NotEnoughBalance
                                insufficientBalanceInfo={
                                    insufficientBalanceInfo
                                }
                            />
                            {/* Vote action paused (approve / reject) — single banner */}
                            {voteBannerSlot && (
                                <SlotWarning slot={voteBannerSlot} />
                            )}
                            {/* Feature-maintenance warning — approval paused, rejection still works */}
                            {!voteBannerSlot &&
                                approveBlocked &&
                                approveBlockedWarning?.slot && (
                                    <SlotWarning
                                        slot={approveBlockedWarning.slot}
                                        token={
                                            approveBlockedWarning.token ??
                                            undefined
                                        }
                                        network={
                                            approveBlockedWarning.network ??
                                            undefined
                                        }
                                    />
                                )}
                            <div className="flex gap-3 w-full sm:invisible sm:group-hover:visible transition-opacity duration-300 ease-in-out">
                                <AuthButtonWithProposal
                                    proposalKind={proposal.kind}
                                    variant="secondary"
                                    className="flex gap-1 w-full"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        onVote("Reject");
                                    }}
                                    disabled={isUserVoter || rejectSlot.blocked}
                                    tooltip={
                                        rejectSlot.inlineTooltip
                                            ? rejectSlot.inlineTooltip
                                            : isUserVoter
                                              ? noVoteMessage
                                              : undefined
                                    }
                                >
                                    <Icon icon={Cancel01Icon} />
                                    {tActions("reject")}
                                </AuthButtonWithProposal>
                                {insufficientBalanceInfo.hasInsufficientBalance &&
                                insufficientBalanceInfo.showDeposit !==
                                    false ? (
                                    <span className="w-full">
                                        <Button
                                            variant="default"
                                            className="flex gap-1 w-full"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                onDeposit(
                                                    insufficientBalanceInfo.tokenId ||
                                                        insufficientBalanceInfo.tokenSymbol,
                                                    insufficientBalanceInfo.tokenNetwork,
                                                );
                                            }}
                                        >
                                            <Icon icon={ArrowDown02Icon} />
                                            {tActions("deposit")}
                                        </Button>
                                    </span>
                                ) : (
                                    <AuthButtonWithProposal
                                        proposalKind={proposal.kind}
                                        variant="default"
                                        className="flex gap-1 w-full"
                                        onClick={(e) => {
                                            e.preventDefault();
                                            onVote("Approve");
                                        }}
                                        disabled={
                                            isUserVoter ||
                                            approveBlocked ||
                                            approveSlot.blocked ||
                                            insufficientBalanceInfo.hasInsufficientBalance
                                        }
                                        tooltip={
                                            approveSlot.inlineTooltip
                                                ? approveSlot.inlineTooltip
                                                : isUserVoter
                                                  ? noVoteMessage
                                                  : undefined
                                        }
                                    >
                                        <Icon icon={CheckIcon} />
                                        {tActions("approve")}
                                    </AuthButtonWithProposal>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                <Icon
                    icon={ArrowRight01Icon}
                    className="shrink-0 text-card group-hover:text-card-foreground transition-colors absolute right-4 top-4"
                />
            </PageCard>
        </Link>
    );
}

export function PendingRequests() {
    const t = useTranslations("requests.pending");
    const { accountId } = useNear();
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const isHidden = isConfidential && isGuestTreasury;
    const router = useRouter();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [voteInfo, setVoteInfo] = useState<{
        vote: "Approve" | "Reject" | "Remove";
        proposals: Proposal[];
    }>({ vote: "Approve", proposals: [] });
    const { data: pendingRequests, isLoading: isRequestsLoading } =
        useProposals(
            treasuryId,
            {
                statuses: ["InProgress"],
                ...(accountId && {
                    voter_votes: `${accountId}:No Voted`,
                }),
            },
            !isHidden,
        );

    const isLoading = isRequestsLoading;

    if (isHidden) {
        return (
            <div className="flex h-fit min-h-[300px] w-full flex-col gap-3">
                <div className="flex justify-between">
                    <div className="flex items-center gap-1">
                        <h2 className="text-nowrap font-bold text-base tracking-tight">
                            {t("title")}
                        </h2>
                    </div>
                </div>
                <ConfidentialState skeleton={<PendingRequestsGridSkeleton />} />
            </div>
        );
    }

    if (isLoading) {
        return <PendingRequestsSkeleton />;
    }

    const hasPendingRequests = (pendingRequests?.proposals?.length ?? 0) > 0;

    return (
        <>
            <div
                className={cn(
                    "flex h-fit w-full flex-col gap-3",
                    !hasPendingRequests ? "min-h-[300px]" : "min-h-[100px]",
                )}
            >
                <div className="flex justify-between">
                    <div className="flex items-center gap-2">
                        <h2 className="text-nowrap font-bold text-base tracking-tight">
                            {t("title")}
                        </h2>
                        {hasPendingRequests && (
                            <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-general-orange-background-faded px-2 font-bold text-general-orange-foreground text-xs tabular-nums">
                                {pendingRequests?.proposals?.length ?? 0}
                            </span>
                        )}
                    </div>

                    {hasPendingRequests && (
                        <Link href={`/${treasuryId}/requests`}>
                            <Button variant="pill" size="sm">
                                {t("viewAll")}
                                <Icon icon={ArrowRight01Icon} />
                            </Button>
                        </Link>
                    )}
                </div>

                {hasPendingRequests ? (
                    <div className="flex flex-col gap-4">
                        {pendingRequests?.proposals
                            ?.slice(0, MAX_DISPLAYED_REQUESTS)
                            .map((proposal) => (
                                <PendingRequestItem
                                    key={proposal.id}
                                    proposal={proposal}
                                    policy={policy!}
                                    treasuryId={treasuryId!}
                                    onVote={(vote) => {
                                        setVoteInfo({
                                            vote,
                                            proposals: [proposal],
                                        });
                                        setIsVoteModalOpen(true);
                                    }}
                                    onDeposit={(tokenSymbol, tokenNetwork) => {
                                        const params = new URLSearchParams();
                                        if (tokenSymbol) {
                                            params.set("token", tokenSymbol);
                                        }
                                        if (tokenNetwork) {
                                            params.set("network", tokenNetwork);
                                        }
                                        const query = params.toString();
                                        router.push(
                                            `/${treasuryId}/dashboard/deposit${
                                                query ? `?${query}` : ""
                                            }`,
                                        );
                                    }}
                                />
                            ))}
                    </div>
                ) : (
                    <PendingRequestsEmpty />
                )}
            </div>
            <VoteModal
                isOpen={isVoteModalOpen}
                onClose={() => setIsVoteModalOpen(false)}
                proposals={voteInfo.proposals}
                vote={voteInfo.vote}
            />
        </>
    );
}
