import { useTranslations } from "next-intl";
import type { Proposal } from "@/lib/proposals-api";
import type {
    BatchPaymentRequestData,
    BountyData,
    ChangeConfigData,
    ChangePolicyData,
    ConfidentialRequestData,
    FactoryInfoUpdateData,
    FunctionCallData,
    MembersData,
    PaymentRequestData,
    SetStakingContractData,
    StakingData,
    SwapRequestData,
    UpgradeData,
    VestingData,
    VoteData,
} from "../../types/index";
import { extractProposalData } from "../../utils/proposal-extractors";
import { BatchPaymentRequestExpanded } from "./batch-payment-expanded";
import { ChangeConfigExpanded } from "./change-config-expanded";
import { ChangePolicyExpanded } from "./change-policy-expanded";
import { useRequestDisplayContext } from "./common/request-display-context";
import { ConfidentialRequestExpanded } from "./confidential-request-expanded";
import { FunctionCallExpanded } from "./function-call-expanded";
import {
    BountyExpanded,
    FactoryInfoUpdateExpanded,
    MembersExpanded,
    SetStakingContractExpanded,
    UpgradeExpanded,
    VoteExpanded,
} from "./governance-expanded";
import { StakingExpanded } from "./staking-expanded";
import { SwapExpanded } from "./swap-expanded";
import { TransferExpanded } from "./transfer-expanded";
import { VestingExpanded } from "./vesting-expanded";

interface InternalExpandedViewProps {
    proposal: Proposal;
    treasuryId?: string;
}

/**
 * The type-specific body of a request: the rows that describe what it does.
 * Exported so the details sheet can host it while each type is renovated.
 * Must be rendered inside a `RequestDisplayProvider`.
 */
export function ExpandedViewInternal({
    proposal,
    treasuryId,
}: InternalExpandedViewProps) {
    const t = useTranslations("proposals.expanded");
    const { type, data } = extractProposalData(proposal, treasuryId);
    const { isExecuted } = useRequestDisplayContext()!;

    switch (type) {
        case "Payment Request":
        case "Move to Confidential": {
            const paymentData = data as PaymentRequestData;
            return <TransferExpanded data={paymentData} />;
        }
        case "Confidential Request": {
            const confidentialData = data as ConfidentialRequestData;
            return (
                <ConfidentialRequestExpanded
                    data={confidentialData}
                    proposalId={proposal.id}
                />
            );
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
