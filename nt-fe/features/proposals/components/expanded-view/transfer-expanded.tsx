import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { Amount } from "../amount";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { User } from "@/components/user";
import { PaymentRequestData } from "../../types/index";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useToken } from "@/hooks/use-treasury-queries";
import { Address } from "@/components/address";
import { NetworkIconDisplay } from "@/components/token-display";
import { NEAR_NETWORK_ID, NEAR_COM_NETWORK_ID } from "@/constants/network-ids";
import {
    getNearComChainIcons,
    isNearComPaymentRoute,
} from "@/lib/intents-network";
import { Skeleton } from "@/components/ui/skeleton";
import { formatTokenDisplayAmount } from "@/lib/utils";

interface TransferExpandedProps {
    data: PaymentRequestData;
}

export function TransferExpanded({ data }: TransferExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const tIntents = useTranslations("intentsQuote");
    const { data: tokenData } = useToken(data.tokenId);
    const tokenChainName = tokenData?.network || NEAR_NETWORK_ID;
    const isNearComDestination = isNearComPaymentRoute(data);

    const shouldFetchDestinationToken =
        !!data.destinationAssetId && !isNearComDestination;
    const { data: destinationTokenData, isLoading: isLoadingDestinationToken } =
        useToken(
            shouldFetchDestinationToken ? data.destinationAssetId : undefined,
        );

    // For cross-chain intents payments, prefer resolved destination token
    // network for recipient links when destinationNetwork carries a token id.
    const recipientChainName = isNearComDestination
        ? NEAR_NETWORK_ID
        : destinationTokenData?.network ||
          (!shouldFetchDestinationToken
              ? data.destinationAssetId
              : undefined) ||
          tokenChainName;
    const hasFeeData = !!data.networkFee;

    const destinationNetworkMeta = useMemo(() => {
        if (isNearComDestination) {
            return {
                name: NEAR_COM_NETWORK_ID,
                chainIcons: getNearComChainIcons(),
            };
        }
        if (!data.destinationAssetId) {
            return {
                name: tokenChainName,
                chainIcons: tokenData?.chainIcons ?? null,
            };
        }
        if (data.destinationAssetId === tokenChainName) {
            return {
                name: tokenChainName,
                chainIcons: tokenData?.chainIcons ?? null,
            };
        }
        if (shouldFetchDestinationToken && destinationTokenData?.network) {
            return {
                name: destinationTokenData.network,
                chainIcons: destinationTokenData.chainIcons ?? null,
            };
        }
        return {
            name: data.destinationAssetId,
            chainIcons: null,
        };
    }, [
        data.destinationAssetId,
        destinationTokenData?.network,
        destinationTokenData?.chainIcons,
        isNearComDestination,
        shouldFetchDestinationToken,
        tokenChainName,
        tokenData?.chainIcons,
    ]);
    const shouldShowDestinationNetworkSkeleton =
        shouldFetchDestinationToken && isLoadingDestinationToken;

    const infoItems: InfoItem[] = [
        {
            label: t("recipient"),
            value: (
                <User
                    accountId={data.receiver}
                    useAddressBook
                    chainName={recipientChainName}
                    withHoverCard
                />
            ),
        },
        {
            label: t("amount"),
            value: (
                <Amount
                    amount={data.amount}
                    tokenId={data.tokenId}
                    showNetworkTooltip
                />
            ),
        },
        {
            label: t("destinationNetwork"),
            value: shouldShowDestinationNetworkSkeleton ? (
                <Skeleton className="h-5 w-28" />
            ) : (
                <NetworkIconDisplay
                    chainIcons={destinationNetworkMeta.chainIcons}
                    networkName={destinationNetworkMeta.name}
                    networkNameClassName="font-normal"
                />
            ),
        },
    ];

    if (hasFeeData) {
        infoItems.push({
            label: t("networkFee"),
            info: tIntents("networkFeeTooltip"),
            value: `${formatTokenDisplayAmount(data.networkFee!)} ${tokenData?.symbol || ""}`.trim(),
        });
    }

    if (data.notes && data.notes !== "") {
        const notes = <span>{data.notes}</span>;
        const content =
            data.url && data.url !== "" ? (
                <Link
                    href={data.url}
                    target="_blank"
                    className="flex items-center gap-5"
                >
                    {notes} <ArrowUpRight className="size-4 shrink-0" />{" "}
                </Link>
            ) : (
                notes
            );
        infoItems.push({ label: t("notes"), value: content });
    }

    const expandableItems: InfoItem[] = [];

    if (data.depositAddress) {
        expandableItems.push({
            label: t("depositAddress"),
            value: <Address address={data.depositAddress} copyable={true} />,
            info: t("depositAddressTooltip"),
        });
    }

    if (data.quoteSignature) {
        expandableItems.push({
            label: t("quoteSignature"),
            value: (
                <Address
                    address={data.quoteSignature}
                    copyable={true}
                    prefixLength={16}
                />
            ),
            info: t("quoteSignatureTooltip"),
        });
    }

    return (
        <InfoDisplay
            items={infoItems}
            expandableItems={
                expandableItems.length > 0 ? expandableItems : undefined
            }
        />
    );
}
