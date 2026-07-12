import { useTranslations } from "next-intl";
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
    ConfidentialRequestData,
    StakingData,
    VestingData,
    SwapRequestData,
    BatchPaymentRequestData,
    BountyData,
    FactoryInfoUpdateData,
    MembersData,
    SetStakingContractData,
    UpgradeData,
    VoteData,
} from "../../types/index";
import {
    BountyExpanded,
    FactoryInfoUpdateExpanded,
    MembersExpanded,
    SetStakingContractExpanded,
    UpgradeExpanded,
    VoteExpanded,
} from "./governance-expanded";
import { ConfidentialRequestExpanded } from "./confidential-request-expanded";
import { BatchPaymentRequestExpanded } from "./batch-payment-expanded";
import { useNear } from "@/stores/near-store";
import { getProposalStatus } from "../../utils/proposal-utils";
import {
    RequestDisplayProvider,
    useRequestDisplayContext,
} from "./common/request-display-context";

interface InternalExpandedViewProps {
    proposal: Proposal;
    policy: Policy;
    treasuryId?: string;
}

function ExpandedViewInternal({
    proposal,
    policy,
    treasuryId,
}: InternalExpandedViewProps) {
    const t = useTranslations("proposals.expanded");
    const { type, data } = extractProposalData(proposal, treasuryId);
    const { isExecuted } = useRequestDisplayContext()!;

    switch (type) {
        case "Payment Request": {
            const paymentData = data as PaymentRequestData;
            return <TransferExpanded data={paymentData} />;
        }
        case "Confidential Request": {
            const confidentialData = data as ConfidentialRequestData;
            return <ConfidentialRequestExpanded data={confidentialData} />;
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
            return (
                <StakingExpanded
                    data={stakingData}
                    proposal={proposal}
                    treasuryId={treasuryId}
                />
            );
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
                <BatchPaymentRequestExpanded
                    data={batchPaymentRequestData}
                    proposal={proposal}
                />
            );
        }
        case "Exchange": {
            const swapData = data as SwapRequestData;
            return <SwapExpanded data={swapData} isExecuted={isExecuted} />;
        }
        case "Members": {
            const membersData = data as MembersData;
            return <MembersExpanded data={membersData} />;
        }
        case "Upgrade": {
            const upgradeData = data as UpgradeData;
            return <UpgradeExpanded data={upgradeData} />;
        }
        case "Set Staking Contract": {
            const setStakingContractData = data as SetStakingContractData;
            return <SetStakingContractExpanded data={setStakingContractData} />;
        }
        case "Bounty": {
            const bountyData = data as BountyData;
            return <BountyExpanded data={bountyData} />;
        }
        case "Vote": {
            const voteData = data as VoteData;
            return <VoteExpanded data={voteData} />;
        }
        case "Factory Info Update": {
            const factoryInfoUpdateData = data as FactoryInfoUpdateData;
            return <FactoryInfoUpdateExpanded data={factoryInfoUpdateData} />;
        }
        default:
            return (
                <p className="text-sm text-muted-foreground">
                    {t("unsupportedProposal")}
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
    const t = useTranslations("proposals.expanded");
    const { treasuryId, isConfidential } = useTreasury();
    const { accountId } = useNear();
    const proposalStatus = getProposalStatus(proposal, policy);
    const isPending = proposalStatus === "Pending";
    const isExecuted = proposalStatus === "Executed";
    const showUsdValue = isPending;

    const component = (
        <RequestDisplayProvider
            value={{
                showUSDValue: showUsdValue,
                isConfidential,
                proposalStatus,
                isPending,
                isExecuted,
            }}
        >
            <ExpandedViewInternal
                proposal={proposal}
                policy={policy}
                treasuryId={treasuryId}
            />
        </RequestDisplayProvider>
    );
    const requestUrl = `${window.location.origin}/${treasuryId}/requests/${proposal.id}`;

    const ownProposal = proposal.proposer === accountId && isPending;
    const isVoted = !!proposal.votes[accountId ?? ""];
    return (
        <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 w-full min-w-0">
            <PageCard className="w-full min-w-0 h-fit">
                <div className="flex items-center justify-between">
                    <h3 className="text-lg font-semibold">
                        {t("requestDetails")}
                    </h3>
                    <div className="flex items-center gap-2">
                        <CopyButton
                            text={requestUrl}
                            toastMessage={t("linkCopied")}
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8"
                            tooltipContent={t("copyLink")}
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
                                    tooltipContent={t("openRequestPage")}
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
                                tooltipContent={t("deleteRequest")}
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
