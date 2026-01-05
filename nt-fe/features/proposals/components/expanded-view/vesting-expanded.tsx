import { InfoDisplay, InfoItem } from "@/components/info-display";
import { FormattedDate } from "@/components/formatted-date";
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
      { label: "Start Date", value: <FormattedDate date={parseInt(data.vestingSchedule.start_timestamp) / 1000000} includeTime={false} /> },
      { label: "End Date", value: <FormattedDate date={parseInt(data.vestingSchedule.end_timestamp) / 1000000} includeTime={false} /> },
      { label: "Cliff Date", value: <FormattedDate date={parseInt(data.vestingSchedule.cliff_timestamp) / 1000000} includeTime={false} /> }
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
