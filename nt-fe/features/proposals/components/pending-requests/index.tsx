import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import {
    AuthButtonWithProposal,
    useNoVoteMessage,
} from "@/components/auth-button";
import { PageCard } from "@/components/card";
import { NumberBadge } from "@/components/number-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useProposals } from "@/hooks/use-proposals";
import { Proposal } from "@/lib/proposals-api";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { ChevronRight, Check, X, Download, Send } from "lucide-react";
import Link from "next/link";
import { ProposalTypeIcon } from "../proposal-type-icon";
import { TransactionCell } from "../transaction-cell";
import { getProposalUIKind } from "../../utils/proposal-utils";
import { useProposalKindLabel } from "../../hooks/use-proposal-kind-label";
import { useProposalInsufficientBalance } from "../../hooks/use-proposal-insufficient-balance";
import { VoteModal } from "../vote-modal";
import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { DepositModal } from "@/app/(treasury)/[treasuryId]/dashboard/components/deposit-modal";
import { EmptyState } from "@/components/empty-state";
import { NotEnoughBalance } from "../not-enough-balance";
import { FormattedDate } from "@/components/formatted-date";
import { Policy } from "@/types/policy";
import { extractConfidentialRequestData } from "../../utils/proposal-extractors";

const MAX_DISPLAYED_REQUESTS = 4;

function PendingRequestItemSkeleton() {
    return <Skeleton className="h-20 w-full rounded-lg" />;
}

function PendingRequestsSkeleton() {
    const t = useTranslations("requests.pending");
    return (
        <div className="border bg-general-tertiary border-border rounded-lg p-5 gap-3 flex flex-col w-full h-fit min-h-[300px]">
            <div className="flex justify-between">
                <div className="flex items-center gap-1">
                    <h1 className="font-semibold text-nowrap">{t("title")}</h1>
                </div>
                <Button variant="ghost" className="flex gap-2" disabled>
                    {t("viewAll")}
                    <ChevronRight className="size-4" />
                </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4">
                {Array.from({ length: MAX_DISPLAYED_REQUESTS }).map(
                    (_, index) => (
                        <PendingRequestItemSkeleton key={index} />
                    ),
                )}
            </div>
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
    const title = useMemo(() => {
        if (type === "Confidential Request") {
            return extractConfidentialRequestData(proposal, treasuryId).title;
        }
        return getProposalKindLabel(type);
    }, [type, proposal, treasuryId, getProposalKindLabel]);

    return (
        <Link href={`/${treasuryId}/requests/${proposal.id}`}>
            <PageCard className="flex relative flex-row gap-3.5 justify-between w-full overflow-hidden group">
                <ProposalTypeIcon proposal={proposal} treasuryId={treasuryId} />
                <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                    <span className="max-w-full truncate leading-none font-semibold">
                        {title}
                    </span>
                    <TransactionCell proposal={proposal} textOnly />
                    <FormattedDate
                        proposal={proposal}
                        policy={policy}
                        relative
                        className="text-xs text-muted-foreground"
                    />
                    <div className="gap-3 grid grid-rows-[1fr] sm:grid-rows-[0fr] pt-4 w-full sm:group-hover:grid-rows-[1fr] transition-[grid-template-rows] duration-300 ease-in-out">
                        <div className="overflow-hidden w-full flex flex-col gap-2">
                            <NotEnoughBalance
                                insufficientBalanceInfo={
                                    insufficientBalanceInfo
                                }
                            />
                            <div className="flex gap-3 w-full sm:invisible sm:group-hover:visible transition-opacity duration-300 ease-in-out">
                                <AuthButtonWithProposal
                                    proposalKind={proposal.kind}
                                    variant="secondary"
                                    className="flex gap-1 w-full"
                                    onClick={(e) => {
                                        e.preventDefault();
                                        onVote("Reject");
                                    }}
                                    tooltip={
                                        isUserVoter ? noVoteMessage : undefined
                                    }
                                    disabled={isUserVoter}
                                >
                                    <X className="size-3.5" />
                                    {tActions("reject")}
                                </AuthButtonWithProposal>
                                {insufficientBalanceInfo.hasInsufficientBalance ? (
                                    <span className="w-full">
                                        <Button
                                            variant="default"
                                            className="flex gap-1 w-full"
                                            onClick={(e) => {
                                                e.preventDefault();
                                                onDeposit(
                                                    insufficientBalanceInfo.tokenSymbol,
                                                    insufficientBalanceInfo.tokenNetwork,
                                                );
                                            }}
                                        >
                                            <Download className="size-3.5" />
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
                                        disabled={isUserVoter}
                                        tooltip={
                                            isUserVoter
                                                ? noVoteMessage
                                                : undefined
                                        }
                                    >
                                        <Check className="size-3.5" />
                                        {tActions("approve")}
                                    </AuthButtonWithProposal>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
                <ChevronRight className="size-4 shrink-0 text-card group-hover:text-card-foreground transition-colors absolute right-4 top-4" />
            </PageCard>
        </Link>
    );
}

export function PendingRequests() {
    const t = useTranslations("requests.pending");
    const { accountId } = useNear();
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const [isVoteModalOpen, setIsVoteModalOpen] = useState(false);
    const [isDepositModalOpen, setIsDepositModalOpen] = useState(false);
    const [{ tokenSymbol, tokenNetwork }, setDepositTokenInfo] = useState<{
        tokenSymbol?: string;
        tokenNetwork?: string;
    }>({});
    const [voteInfo, setVoteInfo] = useState<{
        vote: "Approve" | "Reject" | "Remove";
        proposals: Proposal[];
    }>({ vote: "Approve", proposals: [] });
    const { data: pendingRequests, isLoading: isRequestsLoading } =
        useProposals(treasuryId, {
            statuses: ["InProgress"],
            ...(accountId && {
                voter_votes: `${accountId}:No Voted`,
            }),
        });

    const isLoading = isRequestsLoading;

    if (isLoading) {
        return <PendingRequestsSkeleton />;
    }

    const hasPendingRequests = (pendingRequests?.proposals?.length ?? 0) > 0;

    return (
        <>
            <div
                className={cn(
                    "bg-general-tertiary rounded-lg p-5 gap-3 flex flex-col w-full h-fit",
                    !hasPendingRequests ? "min-h-[300px]" : "min-h-[100px]",
                )}
            >
                <div className="flex justify-between">
                    <div className="flex items-center gap-1">
                        <h1 className="font-semibold text-nowrap">
                            {t("title")}
                        </h1>
                        {hasPendingRequests && (
                            <NumberBadge
                                number={pendingRequests?.proposals?.length ?? 0}
                            />
                        )}
                    </div>

                    {hasPendingRequests && (
                        <Link href={`/${treasuryId}/requests`}>
                            <Button variant="ghost" className="flex gap-2">
                                {t("viewAll")}
                                <ChevronRight className="size-4" />
                            </Button>
                        </Link>
                    )}
                </div>

                {hasPendingRequests ? (
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4">
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
                                        setDepositTokenInfo({
                                            tokenSymbol,
                                            tokenNetwork,
                                        });
                                        setIsDepositModalOpen(true);
                                    }}
                                />
                            ))}
                    </div>
                ) : (
                    <EmptyState
                        icon={Send}
                        title={t("emptyTitle")}
                        description={t("emptyDescription")}
                    />
                )}
            </div>
            <VoteModal
                isOpen={isVoteModalOpen}
                onClose={() => setIsVoteModalOpen(false)}
                proposals={voteInfo.proposals}
                vote={voteInfo.vote}
            />
            <DepositModal
                isOpen={isDepositModalOpen}
                onClose={() => setIsDepositModalOpen(false)}
                prefillTokenSymbol={tokenSymbol}
                prefillNetworkId={tokenNetwork}
            />
        </>
    );
}
