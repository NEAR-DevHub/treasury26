import { InfoDisplay, InfoItem } from "@/components/info-display";
import { formatDate } from "@/lib/utils";
import { Amount } from "../amount";
import { User } from "@/components/user";
import { VestingData } from "../../types/index";

interface VestingExpandedProps {
  data: VestingData;
}

export function VestingExpanded({ data }: VestingExpandedProps) {
  const infoItems: InfoItem[] = [
    { label: "Recipient", value: <User accountId={data.receiver} /> },
    {
      label: "Amount",
      value: <Amount amount={data.amount} tokenId={data.tokenId} />
    },
  ];

  if (data.vestingSchedule) {
    infoItems.push(
      { label: "Start Date", value: <span>{formatDate(parseInt(data.vestingSchedule.start_timestamp) / 1000000)}</span> },
      { label: "End Date", value: <span>{formatDate(parseInt(data.vestingSchedule.end_timestamp) / 1000000)}</span> },
      { label: "Cliff Date", value: <span>{formatDate(parseInt(data.vestingSchedule.cliff_timestamp) / 1000000)}</span> }
    );
  }

  infoItems.push(
    { label: "Allow Cancellation", value: <span>{data.allowCancellation ? "Yes" : "No"}</span> },
    { label: "Allow Staking", value: <span>{data.allowStaking ? "Yes" : "No"}</span> }
  );

  if (data.notes && data.notes !== "") {
    infoItems.push({ label: "Notes", value: <span>{data.notes}</span> });
  }

  return (
    <InfoDisplay items={infoItems} />
  );
}
