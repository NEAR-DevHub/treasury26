import { useTranslations } from "next-intl";
import { InfoDisplay, type InfoItem } from "@/components/info-display";
import { User } from "@/components/user";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import type {
    BountyData,
    FactoryInfoUpdateData,
    MembersData,
    SetStakingContractData,
    UpgradeData,
    VoteData,
} from "../../types/index";
import { Amount } from "../amount";

const NANOS_PER_DAY = 24n * 60n * 60n * 1_000_000_000n;

export function MembersExpanded({ data }: { data: MembersData }) {
    const t = useTranslations("proposals.expanded");

    const items: InfoItem[] = [
        {
            label: t("action"),
            value: data.action === "add" ? t("addMember") : t("removeMember"),
        },
        {
            label: t("member"),
            value: <User accountId={data.memberId} />,
        },
        {
            label: t("role"),
            value: data.role,
        },
    ];

    return <InfoDisplay items={items} />;
}

export function UpgradeExpanded({ data }: { data: UpgradeData }) {
    const t = useTranslations("proposals.expanded");

    const items: InfoItem[] = [
        {
            label: t("action"),
            value: data.type === "self" ? t("upgradeSelf") : t("upgradeRemote"),
        },
        {
            label: t("codeHash"),
            value: <span className="break-all">{data.hash}</span>,
        },
    ];

    if (data.type === "remote") {
        if (data.receiverId) {
            items.push({
                label: t("receiverId"),
                value: <User accountId={data.receiverId} />,
            });
        }
        if (data.methodName) {
            items.push({
                label: t("methodName"),
                value: data.methodName,
            });
        }
    }

    return <InfoDisplay items={items} />;
}

export function SetStakingContractExpanded({
    data,
}: {
    data: SetStakingContractData;
}) {
    const t = useTranslations("proposals.expanded");

    const items: InfoItem[] = [
        {
            label: t("stakingContract"),
            value: <User accountId={data.stakingId} />,
        },
    ];

    return <InfoDisplay items={items} />;
}

function formatDeadlineDays(maxDeadline: string): number | null {
    try {
        return Number(BigInt(maxDeadline) / NANOS_PER_DAY);
    } catch {
        return null;
    }
}

export function BountyExpanded({ data }: { data: BountyData }) {
    const t = useTranslations("proposals.expanded");

    const items: InfoItem[] = [
        {
            label: t("action"),
            value: data.action === "add" ? t("addBounty") : t("bountyDone"),
        },
    ];

    if (data.action === "add") {
        if (data.description) {
            items.push({
                label: t("description"),
                value: data.description,
            });
        }
        items.push({
            label: t("amount"),
            // Empty token means the chain's base token (NEAR)
            value: (
                <Amount
                    amount={data.amount ?? "0"}
                    tokenId={data.token || NEAR_NETWORK_ID}
                />
            ),
        });
        if (data.times !== undefined) {
            items.push({
                label: t("bountyTimes"),
                value: data.times,
            });
        }
        if (data.maxDeadline) {
            const days = formatDeadlineDays(data.maxDeadline);
            items.push({
                label: t("maxDeadline"),
                value:
                    days !== null
                        ? t("daysCount", { count: days })
                        : data.maxDeadline,
            });
        }
    } else {
        items.push({
            label: t("bountyId"),
            value: `#${data.bountyId ?? 0}`,
        });
        if (data.receiverId) {
            items.push({
                label: t("recipient"),
                value: <User accountId={data.receiverId} />,
            });
        }
    }

    return <InfoDisplay items={items} />;
}

export function VoteExpanded({ data }: { data: VoteData }) {
    const t = useTranslations("proposals.expanded");

    const items: InfoItem[] = [
        {
            label: t("description"),
            value: <span className="break-words">{data.message}</span>,
        },
    ];

    return <InfoDisplay items={items} />;
}

export function FactoryInfoUpdateExpanded({
    data,
}: {
    data: FactoryInfoUpdateData;
}) {
    const t = useTranslations("proposals.expanded");

    const items: InfoItem[] = [
        {
            label: t("factoryId"),
            value: <User accountId={data.factoryId} />,
        },
        {
            label: t("autoUpdate"),
            value: data.autoUpdate ? t("yes") : t("no"),
        },
    ];

    return <InfoDisplay items={items} />;
}
