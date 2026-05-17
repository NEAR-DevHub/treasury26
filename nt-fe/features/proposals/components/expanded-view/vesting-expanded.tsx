import { useTranslations } from "next-intl";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { FormattedDate } from "@/components/formatted-date";
import { Amount } from "../amount";
import { User } from "@/components/user";
import { VestingData } from "../../types/index";

interface VestingExpandedProps {
    data: VestingData;
}

export function VestingExpanded({ data }: VestingExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const infoItems: InfoItem[] = [
        {
            label: t("recipient"),
            value: <User accountId={data.receiver} useAddressBook />,
        },
        {
            label: t("amount"),
            value: (
                <Amount
                    amount={data.amount}
                    showNetworkTooltip
                    tokenId={data.tokenId}
                />
            ),
        },
    ];

    if (data.vestingSchedule) {
        infoItems.push(
            {
                label: t("startDate"),
                value: (
                    <FormattedDate
                        date={
                            parseInt(data.vestingSchedule.start_timestamp) /
                            1000000
                        }
                        includeTime={false}
                    />
                ),
            },
            {
                label: t("endDate"),
                value: (
                    <FormattedDate
                        date={
                            parseInt(data.vestingSchedule.end_timestamp) /
                            1000000
                        }
                        includeTime={false}
                    />
                ),
            },
            {
                label: t("cliffDate"),
                value: (
                    <FormattedDate
                        date={
                            parseInt(data.vestingSchedule.cliff_timestamp) /
                            1000000
                        }
                        includeTime={false}
                    />
                ),
            },
        );
    }

    infoItems.push(
        {
            label: t("allowCancellation"),
            value: <span>{data.allowCancellation ? t("yes") : t("no")}</span>,
        },
        {
            label: t("allowStaking"),
            value: <span>{data.allowStaking ? t("yes") : t("no")}</span>,
        },
    );

    if (data.notes && data.notes !== "") {
        infoItems.push({
            label: t("notes"),
            value: <span>{data.notes}</span>,
        });
    }

    return <InfoDisplay items={infoItems} />;
}
