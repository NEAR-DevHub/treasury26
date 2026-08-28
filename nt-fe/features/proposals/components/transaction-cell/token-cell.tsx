import { Icon } from "@/components/icon";
import { Shield01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import {
    PaymentRequestData,
    VestingData,
    StakingData,
} from "../../types/index";
import { Amount } from "../amount";
import { TooltipUser } from "@/components/user";
import { TitleSubtitleCell } from "./title-subtitle-cell";
import { useProfile, useToken } from "@/hooks/use-treasury-queries";
import { TokenDisplay } from "@/components/token-display-with-network";
import { useTreasury } from "@/hooks/use-treasury";
import { Tooltip } from "@/components/tooltip";
import { isNearComPaymentRoute } from "@/lib/intents-network";
import { Address } from "@/components/address";

/**
 * The 36px token badge the row shows to the left of the amount. Split out of
 * `Amount` so the "to: ..." line can sit under the amount instead of under the
 * badge.
 */
function TokenIcon({ tokenId, nearFt }: { tokenId: string; nearFt?: boolean }) {
    const { data: token } = useToken(
        tokenId,
        nearFt ? { nearFt: true } : undefined,
    );
    if (!token) return null;
    return (
        <TokenDisplay
            symbol={token.symbol}
            icon={token.icon ?? ""}
            chainIcons={token.chainIcons}
            iconSize="xl"
        />
    );
}

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
    const title = (
        <Amount
            amount={data.amount}
            tokenId={data.tokenId}
            showUSDValue={false}
            showNetworkTooltip
            expandNearComLabel={"destinationAssetId" in data}
            showIcon={false}
            textOnly={textOnly}
            nearFt={nearFt}
        />
    );
    const { data: profile } = useProfile(data.receiver);
    const address = profile?.addressBookName ?? data.receiver;
    const destinationAssetId =
        "destinationAssetId" in data ? data.destinationAssetId : undefined;
    const showConfidentialAddressShield =
        isConfidential &&
        "destinationAssetId" in data &&
        isNearComPaymentRoute(data);

    const subtitle = data.receiver ? (
        <div className="flex min-w-0 max-w-full items-center overflow-hidden">
            <span className="shrink-0">{effectivePrefix}</span>
            {showConfidentialAddressShield && (
                <Tooltip content={tCommon("confidentialAddressTooltip")}>
                    <span className="inline-flex align-middle ml-1">
                        <Icon icon={Shield01Icon} className="fill-foreground" />
                    </span>
                </Tooltip>
            )}
            {isUser ? (
                <TooltipUser
                    accountId={data.receiver}
                    useAddressBook
                    chainName={destinationAssetId}
                >
                    <div className="ml-1 min-w-0 flex-1 overflow-hidden">
                        <Address
                            address={address}
                            prefixLength={6}
                            suffixLength={6}
                            className="min-w-0 truncate"
                        />
                    </div>
                </TooltipUser>
            ) : (
                <span className="ml-1 min-w-0 flex-1 truncate">{address}</span>
            )}
        </div>
    ) : undefined;

    return (
        <TitleSubtitleCell
            title={title}
            subtitle={subtitle}
            icon={
                textOnly ? undefined : (
                    <TokenIcon tokenId={data.tokenId} nearFt={nearFt} />
                )
            }
            timestamp={timestamp}
        />
    );
}
