import { useTranslations } from "next-intl";
import { Shield } from "lucide-react";
import {
    PaymentRequestData,
    VestingData,
    StakingData,
} from "../../types/index";
import { Amount } from "../amount";
import { resolveUserDisplayName, TooltipUser } from "@/components/user";
import { TitleSubtitleCell } from "./title-subtitle-cell";
import { useProfile } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { Tooltip } from "@/components/tooltip";
import { isNearComPaymentRoute } from "@/lib/intents-network";
import { formatRecipientForNearComDestination } from "@/lib/nearcom-address";
import { Address } from "@/components/address";

interface TokenCellProps {
    data: PaymentRequestData | VestingData | StakingData;
    prefix?: string;
    isUser?: boolean;
    timestamp?: string;
    textOnly?: boolean;
}

export function TokenCell({
    data,
    prefix,
    isUser = true,
    timestamp,
    textOnly = false,
}: TokenCellProps) {
    const t = useTranslations("proposals.expanded");
    const tCommon = useTranslations("common");
    const { isConfidential } = useTreasury();
    const effectivePrefix = prefix ?? t("toPrefix");
    const nearFt = "nearFt" in data ? data.nearFt : undefined;
    const destinationAssetId =
        "destinationAssetId" in data ? data.destinationAssetId : undefined;
    const isNearComDestination = isNearComPaymentRoute(destinationAssetId);
    const title = (
        <Amount
            amount={data.amount}
            tokenId={data.tokenId}
            showUSDValue={false}
            showNetworkTooltip
            expandNearComLabel={isNearComDestination}
            iconSize="sm"
            textOnly={textOnly}
            nearFt={nearFt}
        />
    );
    const { data: profile } = useProfile(data.receiver);
    const displayReceiver = formatRecipientForNearComDestination(
        data.receiver,
        destinationAssetId,
    );
    const displayName = resolveUserDisplayName({
        accountId: data.receiver,
        profileName: profile?.name,
    });
    const nameIsAddress =
        displayName.trim().toLowerCase() === data.receiver.trim().toLowerCase();
    const showConfidentialAddressShield =
        isConfidential && isNearComDestination;

    const subtitle = data.receiver ? (
        <div className="flex min-w-0 max-w-full items-center overflow-hidden">
            <span className="shrink-0">{effectivePrefix}</span>
            {showConfidentialAddressShield && (
                <Tooltip content={tCommon("confidentialAddressTooltip")}>
                    <span className="inline-flex align-middle ml-1">
                        <Shield className="size-3.5 fill-foreground" />
                    </span>
                </Tooltip>
            )}
            {isUser ? (
                <TooltipUser
                    accountId={data.receiver}
                    displayAddress={displayReceiver}
                    chainName={destinationAssetId}
                >
                    <div className="ml-1 min-w-0 flex-1 overflow-hidden">
                        {nameIsAddress ? (
                            <Address
                                address={displayReceiver}
                                prefixLength={6}
                                suffixLength={6}
                                className="min-w-0 truncate"
                            />
                        ) : (
                            <span className="min-w-0 truncate block">
                                {displayName}
                            </span>
                        )}
                    </div>
                </TooltipUser>
            ) : (
                <span className="ml-1 min-w-0 flex-1 truncate">
                    {displayName}
                </span>
            )}
        </div>
    ) : undefined;

    return (
        <TitleSubtitleCell
            title={title}
            subtitle={subtitle}
            timestamp={timestamp}
        />
    );
}
