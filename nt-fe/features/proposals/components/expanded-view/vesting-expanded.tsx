import { Proposal } from "@/lib/proposals-api";
import { InfoDisplay } from "@/components/info-display";
import { formatNearAmount, decodeArgs, formatDate, decodeProposalDescription } from "@/lib/utils";
import { NEAR_TOKEN } from "@/constants/token";
import { useTokenPrice } from "@/hooks/use-treasury-queries";
import { useMemo } from "react";
import { LOCKUP_NO_WHITELIST_ACCOUNT_ID } from "@/constants/config";
import { Amount } from "../amount";

interface VestingExpandedProps {
  proposal: Proposal;
}

export function VestingExpanded({ proposal }: VestingExpandedProps) {
  if (!('FunctionCall' in proposal.kind)) return null;
  const { data: usdPrice } = useTokenPrice("near", "NEAR");

  const functionCall = proposal.kind.FunctionCall;
  const receiver = functionCall.receiver_id;

  // Check if this is a vesting transaction (create on lockup.near)
  const isVesting = receiver.includes('lockup.near') || receiver === 'lockup.near';
  if (!isVesting) return null;

  const firstAction = functionCall.actions[0];
  if (!firstAction || firstAction.method_name !== 'create') return null;

  const args = decodeArgs(firstAction.args);
  if (!args) return null;

  const vestingSchedule = args.vesting_schedule?.VestingSchedule;
  const whitelistAccountId = args.whitelist_account_id;
  const foundationAccountId = args.foundation_account_id;
  const recipient = args.owner_account_id;
  const nearAmount = formatNearAmount(firstAction.deposit);

  const estimatedUSDValue = useMemo(() => {
    if (!usdPrice?.price || !firstAction.deposit || isNaN(Number(firstAction.deposit))) {
      return 0;
    }
    return Number(nearAmount) * usdPrice.price;
  }, [usdPrice?.price, firstAction.deposit]);

  const infoItems = [
    { label: "Recipient", value: recipient || "N/A" },
    {
      label: "Amount",
      value: <Amount amount={nearAmount} tokenId="near" />
    },
  ];

  if (vestingSchedule) {
    infoItems.push(
      { label: "Start Date", value: formatDate(parseInt(vestingSchedule.start_timestamp) / 1000000) },
      { label: "End Date", value: formatDate(parseInt(vestingSchedule.end_timestamp) / 1000000) },
      { label: "Cliff Date", value: formatDate(parseInt(vestingSchedule.cliff_timestamp) / 1000000) }
    );
  }

  infoItems.push(
    { label: "Allow Cancellation", value: foundationAccountId ? "Yes" : "No" },
    { label: "Allow Staking", value: whitelistAccountId === LOCKUP_NO_WHITELIST_ACCOUNT_ID ? "No" : "Yes" }
  );

  const notes = decodeProposalDescription("notes", proposal.description);
  if (notes && notes !== "") {
    infoItems.push({ label: "Notes", value: notes });
  }

  return (
    <InfoDisplay items={infoItems} />
  );
}
