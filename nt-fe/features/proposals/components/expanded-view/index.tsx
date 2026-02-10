import { Proposal } from "@/lib/proposals-api";
import { TransferExpanded } from "./transfer-expanded";
import { FunctionCallExpanded } from "./function-call-expanded";
import { ChangePolicyExpanded } from "./change-policy-expanded";
import { VestingExpanded } from "./vesting-expanded";
import { ProposalSidebar } from "./common/proposal-sidebar";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { CopyButton } from "@/components/copy-button";
import { ExternalLink, Trash } from "lucide-react";
import { Policy } from "@/types/policy";
import { StakingExpanded } from "./staking-expanded";
import { ChangeConfigExpanded } from "./change-config-expanded";
import { SwapExpanded } from "./swap-expanded";
import { useTreasury } from "@/hooks/use-treasury";
import Link from "next/link";
import { extractProposalData } from "../../utils/proposal-extractors";
import {
    PaymentRequestData,
    FunctionCallData,
    ChangePolicyData,
    ChangeConfigData,
    StakingData,
    VestingData,
    SwapRequestData,
    BatchPaymentRequestData,
} from "../../types/index";
import { BatchPaymentRequestExpanded } from "./batch-payment-expanded";
import { useNear } from "@/stores/near-store";
import { getProposalStatus } from "../../utils/proposal-utils";

interface InternalExpandedViewProps {
    proposal: Proposal;
}

function ExpandedViewInternal({ proposal }: InternalExpandedViewProps) {
    const { type, data } = extractProposalData(proposal);

    switch (type) {
        case "Payment Request": {
            const paymentData = data as PaymentRequestData;
            return <TransferExpanded data={paymentData} />;
        }
        case "Function Call": {
            const functionCallData = data as FunctionCallData;
            return <FunctionCallExpanded data={functionCallData} />;
        }
        case "Change Policy": {
            const policyData = data as ChangePolicyData;
            return (
                <ChangePolicyExpanded data={policyData} proposal={proposal} />
            );
        }
        case "Vesting": {
            const vestingData = data as VestingData;
            return <VestingExpanded data={vestingData} />;
        }
        case "Earn NEAR":
        case "Unstake NEAR":
        case "Withdraw Earnings": {
            const stakingData = data as StakingData;
            return <StakingExpanded data={stakingData} />;
        }
        case "Update General Settings": {
            const configData = data as ChangeConfigData;
            return (
                <ChangeConfigExpanded data={configData} proposal={proposal} />
            );
        }
        case "Batch Payment Request": {
            const batchPaymentRequestData = data as BatchPaymentRequestData;
            return (
                <BatchPaymentRequestExpanded data={batchPaymentRequestData} />
            );
        }
        case "Exchange": {
            const swapData = data as SwapRequestData;
            return <SwapExpanded data={swapData} />;
        }
        default:
            return (
                <p className="text-sm text-muted-foreground">
                    Unsupported proposal type
                </p>
            );
    }
}

interface ExpandedViewProps {
    proposal: Proposal;
    policy: Policy;
    hideOpenInNewTab?: boolean;
    onVote: (vote: "Approve" | "Reject" | "Remove") => void;
    onDeposit: (tokenSymbol?: string, tokenNetwork?: string) => void;
}

export function ExpandedView({
    proposal,
    policy,
    hideOpenInNewTab = false,
    onVote,
    onDeposit,
}: ExpandedViewProps) {
    const { treasuryId } = useTreasury();
    const { accountId } = useNear();

    const component = ExpandedViewInternal({ proposal });
    const requestUrl = `${window.location.origin}/${treasuryId}/requests/${proposal.id}`;

    const ownProposal =
        proposal.proposer === accountId &&
        getProposalStatus(proposal, policy) === "Pending";
    const isVoted = !!proposal.votes[accountId ?? ""];
    return (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 w-full min-w-0">
            <PageCard className="w-full min-w-0 h-fit">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">Request Details</h3>
                    <div className="flex items-center gap-2">
                        <CopyButton
                            text={requestUrl}
                            toastMessage="Link copied to clipboard"
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            tooltipContent="Copy Link"
                            iconClassName="h-4 w-4"
                        />
                        {!hideOpenInNewTab && (
                            <Link
                                href={requestUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                            >
                                <Button
                                    variant="ghost"
                                    size="icon"
                                    tooltipContent="Open Request Page"
                                    className="h-8 w-8"
                                >
                                    <ExternalLink className="h-4 w-4" />
                                </Button>
                            </Link>
                        )}
                        {ownProposal && !isVoted && (
                            <Button
                                variant="ghost"
                                size="icon"
                                tooltipContent="Delete Request"
                                className="h-8 w-8"
                                onClick={() => onVote("Remove")}
                            >
                                <Trash className="h-4 w-4" />
                            </Button>
                        )}
                    </div>
                </div>
                {component}
            </PageCard>

            <div className="w-full min-w-0">
                <ProposalSidebar
                    proposal={proposal}
                    policy={policy}
                    onVote={onVote}
                    onDeposit={onDeposit}
                />
            </div>
        </div>
    );
}
