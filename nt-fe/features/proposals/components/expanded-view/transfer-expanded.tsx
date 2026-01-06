import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { User } from "@/components/user";
import { PaymentRequestData } from "../../types/index";

interface TransferExpandedProps {
  data: PaymentRequestData;
}

export function TransferExpanded({ data }: TransferExpandedProps) {
  const infoItems: InfoItem[] = [
    {
      label: "Recipient",
      value: <User accountId={data.receiver} />
    },
    {
      label: "Amount",
      value: <Amount amount={data.amount} showNetwork tokenId={data.tokenId} />
    }
  ];

  if (data.notes && data.notes !== "") {
    infoItems.push({ label: "Notes", value: <span>{data.notes}</span> });
  }

  return (
    <InfoDisplay items={infoItems} />
  );
}
