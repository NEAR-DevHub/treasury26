import { useTranslations } from "next-intl";
import type {
    BountyData,
    FactoryInfoUpdateData,
    MembersData,
    SetStakingContractData,
    UpgradeData,
    VoteData,
} from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface GovernanceCellProps<T> {
    data: T;
    timestamp?: string;
}

export function MembersCell({
    data,
    timestamp,
}: GovernanceCellProps<MembersData>) {
    const t = useTranslations("proposals.expanded");
    return (
        <TitleSubtitleCell
            title={data.action === "add" ? t("addMember") : t("removeMember")}
            subtitle={t("memberRoleSubtitle", {
                member: data.memberId,
                role: data.role,
            })}
            timestamp={timestamp}
        />
    );
}

export function UpgradeCell({
    data,
    timestamp,
}: GovernanceCellProps<UpgradeData>) {
    const t = useTranslations("proposals.expanded");
    return (
        <TitleSubtitleCell
            title={data.type === "self" ? t("upgradeSelf") : t("upgradeRemote")}
            subtitle={data.type === "self" ? data.hash : data.receiverId}
            timestamp={timestamp}
        />
    );
}

export function SetStakingContractCell({
    data,
    timestamp,
}: GovernanceCellProps<SetStakingContractData>) {
    const t = useTranslations("proposals.expanded");
    const tKinds = useTranslations("proposalKinds");
    return (
        <TitleSubtitleCell
            title={tKinds("Set Staking Contract")}
            subtitle={data.stakingId || t("detailsUnavailable")}
            timestamp={timestamp}
        />
    );
}

export function BountyCell({
    data,
    timestamp,
}: GovernanceCellProps<BountyData>) {
    const t = useTranslations("proposals.expanded");
    return (
        <TitleSubtitleCell
            title={data.action === "add" ? t("addBounty") : t("bountyDone")}
            subtitle={
                data.action === "add"
                    ? data.description
                    : t("bountyDoneSubtitle", {
                          id: data.bountyId ?? 0,
                          receiver: data.receiverId ?? "",
                      })
            }
            timestamp={timestamp}
        />
    );
}

export function VoteCell({ data, timestamp }: GovernanceCellProps<VoteData>) {
    const tKinds = useTranslations("proposalKinds");
    return (
        <TitleSubtitleCell
            title={tKinds("Vote")}
            subtitle={data.message}
            timestamp={timestamp}
        />
    );
}

export function FactoryInfoUpdateCell({
    data,
    timestamp,
}: GovernanceCellProps<FactoryInfoUpdateData>) {
    const tKinds = useTranslations("proposalKinds");
    return (
        <TitleSubtitleCell
            title={tKinds("Factory Info Update")}
            subtitle={data.factoryId}
            timestamp={timestamp}
        />
    );
}
