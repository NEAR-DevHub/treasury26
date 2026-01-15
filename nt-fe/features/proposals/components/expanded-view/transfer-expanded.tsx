import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { User } from "@/components/user";
import { PaymentRequestData } from "../../types/index";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";

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
    const notes = <span>{data.notes}</span>;
    const content = data.url && data.url !== "" ?
      <Link href={data.url} target="_blank" className="flex items-center gap-5">{notes} <ArrowUpRight className="size-4 shrink-0" /> </Link>
      : notes;
    infoItems.push({ label: "Notes", value: content });
  }

  return (
    <InfoDisplay items={infoItems} />
  );
}
