import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { NumberBadge } from "@/components/number-badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useProposals } from "@/hooks/use-proposals";
import { Proposal } from "@/lib/proposals-api";
import { useTreasury } from "@/stores/treasury-store";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { ProposalTypeIcon } from "../proposal-type-icon";
import { TransactionCell } from "../transaction-cell";
import { Policy } from "@/types/policy";
import { TreasuryConfig } from "@/lib/api";
import { useTreasuryConfig, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { getProposalUIKind } from "../../utils/proposal-utils";

const MAX_DISPLAYED_REQUESTS = 4;

function PendingRequestItemSkeleton() {
    return (
        <Skeleton className="h-20 w-full rounded-lg" />
    );
}

function PendingRequestsSkeleton() {
    return (
        <div className="border bg-general-tertiary border-border rounded-lg p-5 gap-3 flex flex-col w-full h-fit min-h-[300px]">
            <div className="flex justify-between">
                <div className="flex items-center gap-1">
                    <h1 className="font-semibold text-nowrap">Pending Requests</h1>
                </div>
                <Button variant="ghost" className="flex gap-2" disabled>
                    View All
                    <ArrowRight className="size-4" />
                </Button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4">
                {Array.from({ length: MAX_DISPLAYED_REQUESTS }).map((_, index) => (
                    <PendingRequestItemSkeleton key={index} />
                ))}
            </div>
        </div>
    );
}

export function PendingRequestItem({ proposal, policy, config, accountId }: { proposal: Proposal, policy: Policy, config: TreasuryConfig, accountId: string }) {
    const type = getProposalUIKind(proposal);

    return (
        <Link href={`/${accountId}/requests/${proposal.id}`}>
            <PageCard className="flex flex-row gap-3.5 max-w-md items-start">
                <ProposalTypeIcon proposal={proposal} />
                <div className="flex flex-col gap-px">
                    <span className="leading-none font-semibold">{type}</span>
                    <TransactionCell proposal={proposal} policy={policy} config={config} withDate={true} textOnly />
                </div>
            </PageCard>
        </Link>
    );
}

export function PendingRequests() {
    const { selectedTreasury: accountId } = useTreasury();
    const { data: treasury, isLoading: isTreasuryLoading } = useTreasuryConfig(accountId);
    const { data: policy, isLoading: isPolicyLoading } = useTreasuryPolicy(accountId);
    const { data: pendingRequests, isLoading: isRequestsLoading } = useProposals(accountId, {
        statuses: ["InProgress"],
    });

    const isLoading = isTreasuryLoading || isPolicyLoading || isRequestsLoading;

    if (isLoading || !treasury || !policy || !accountId) {
        return <PendingRequestsSkeleton />;
    }

    const hasPendingRequests = (pendingRequests?.proposals?.length ?? 0) > 0;

    return (
        <div className="border bg-general-tertiary border-border rounded-lg p-5 gap-3 flex flex-col w-full h-fit min-h-[300px]">
            <div className="flex justify-between">
                <div className="flex items-center gap-1">
                    <h1 className="font-semibold text-nowrap">Pending Requests</h1>
                    {hasPendingRequests && (
                        <NumberBadge number={pendingRequests?.proposals?.length ?? 0} />
                    )}
                </div>

                {hasPendingRequests && (
                    <Link href={`/${accountId}/requests`}>
                        <Button variant="ghost" className="flex gap-2">
                            View All
                            <ArrowRight className="size-4" />
                        </Button>
                    </Link>
                )}
            </div>

            {hasPendingRequests ? (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-1 gap-4">
                    {pendingRequests?.proposals?.slice(0, MAX_DISPLAYED_REQUESTS).map((proposal) => (
                        <PendingRequestItem key={proposal.id} proposal={proposal} policy={policy} config={treasury.config} accountId={accountId} />
                    ))}
                </div>
            ) : (
                <div className="flex flex-col gap-0.5 w-full h-full items-center justify-center my-auto">
                    <h1 className="font-semibold">All caught up!</h1>
                    <p className="text-xs text-muted-foreground">There are no pending requests.</p>
                </div>
            )}
        </div>
    );
}
