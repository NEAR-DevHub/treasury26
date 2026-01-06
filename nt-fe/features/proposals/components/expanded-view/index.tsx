import { Proposal } from "@/lib/proposals-api";
import { TransferExpanded } from "./transfer-expanded";
import { FunctionCallExpanded } from "./function-call-expanded";
import { ChangePolicyExpanded } from "./change-policy-expanded";
import { VestingExpanded } from "./vesting-expanded";
import { ProposalSidebar } from "./common/proposal-sidebar";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { Copy, ExternalLink } from "lucide-react";
import { TxDetails } from "./common/tx-details";
import { Policy } from "@/types/policy";
import { StakingExpanded } from "./staking-expanded";
import { ChangeConfigExpanded } from "./change-config-expanded";
import { SwapExpanded } from "./swap-expanded";
import { useTreasury } from "@/stores/treasury-store";
import Link from "next/link";
import { toast } from "sonner";
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

interface ExpandedViewProps {
  proposal: Proposal;
  policy: Policy;
  hideOpenInNewTab?: boolean;
}

function ExpandedViewInternal({ proposal, policy }: ExpandedViewProps) {
  const { type, data } = extractProposalData(proposal, policy);

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
      return <ChangePolicyExpanded data={policyData} />;
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
      return <ChangeConfigExpanded data={configData} />;
    }
    case "Batch Payment Request": {
      const batchPaymentRequestData = data as BatchPaymentRequestData;
      return <BatchPaymentRequestExpanded data={batchPaymentRequestData} />;
    }
    case "Exchange": {
      const swapData = data as SwapRequestData;
      return <SwapExpanded data={swapData} />;
    }
    default:
      return (
        <p className="text-sm text-muted-foreground">Unsupported proposal type</p>
      );
  }
}

export function ExpandedView({ proposal, policy, hideOpenInNewTab = false }: ExpandedViewProps) {
  const { selectedTreasury } = useTreasury();
  const component = ExpandedViewInternal({ proposal, policy });
  const requestUrl = `${window.location.origin}/${selectedTreasury}/requests/${proposal.id}`;
  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(requestUrl);
      toast.success("Link copied to clipboard");
    } catch (error) {
      toast.error("Failed to copy link");
    }
  }

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-4 w-full">
      <div className="w-full flex flex-col gap-4">
        <PageCard className="w-full">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">Request Details</h3>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-8 w-8" onClick={onCopy}>
                <Copy className="h-4 w-4" />
              </Button>
              {!hideOpenInNewTab && (
                <Link href={requestUrl} target="_blank" rel="noopener noreferrer">
                  <Button variant="ghost" size="icon" className="h-8 w-8">
                    <ExternalLink className="h-4 w-4" />
                  </Button>
                </Link>
              )}
            </div>
          </div>
          {component}
        </PageCard>

        <TxDetails proposal={proposal} policy={policy} />
      </div>
      <div className="w-full">
        <ProposalSidebar proposal={proposal} policy={policy} />
      </div>

    </div>
  )
}
