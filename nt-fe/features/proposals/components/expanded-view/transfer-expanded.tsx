import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Address } from "@/components/address";
import { FormattedAmount } from "@/components/formatted-amount";
import { InfoDisplay, type InfoItem } from "@/components/info-display";
import { NetworkIconDisplay } from "@/components/token-display";
import { Skeleton } from "@/components/ui/skeleton";
import { User } from "@/components/user";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useQuoteByDepositAddress } from "@/hooks/use-proposals";
import { useToken } from "@/hooks/use-treasury-queries";
import { formatRecipientForNearComDestination } from "@/lib/nearcom-address";
import { useDestinationNetworkMeta } from "../../hooks/use-destination-network-meta";
import type { PaymentRequestData } from "../../types/index";
import { Amount } from "../amount";
import { useRequestDisplayContext } from "./common/request-display-context";

interface TransferExpandedProps {
    data: PaymentRequestData;
}

export function TransferExpanded({ data }: TransferExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const tIntents = useTranslations("intentsQuote");
    const requestDisplayContext = useRequestDisplayContext();
    const isExecuted = requestDisplayContext?.isExecuted ?? false;
    const { data: tokenData } = useToken(
        data.tokenId,
        data.nearFt ? { nearFt: true } : undefined,
    );
    const tokenChainName = tokenData?.network || NEAR_NETWORK_ID;
    const {
        recipientChainName,
        destinationNetworkMeta,
        shouldShowDestinationNetworkSkeleton,
    } = useDestinationNetworkMeta({
        destinationAssetId: data.destinationAssetId,
        originTokenId: data.tokenId,
        originNetwork: tokenChainName,
        originChainIcons: tokenData?.chainIcons,
    });
    const hasFeeData = !!data.networkFee;
    const shouldLoadQuoteUsd =
        data.usdValue !== null &&
        isExecuted &&
        !!data.depositAddress &&
        !data.quoteAmountInUsd;
    const { data: quoteByDepositAddress } = useQuoteByDepositAddress(
        data.depositAddress || null,
        undefined,
        shouldLoadQuoteUsd,
    );
    const amountUsdFromQuote =
        data.quoteAmountInUsd ?? quoteByDepositAddress?.amountInUsd;
    const amountUsdOverride =
        data.usdValue !== null &&
        amountUsdFromQuote &&
        !Number.isNaN(Number(amountUsdFromQuote)) ? (
            <FormattedAmount kind="fiat" value={amountUsdFromQuote} />
        ) : null;

    const displayReceiver = formatRecipientForNearComDestination(
        data.receiver,
        data.destinationAssetId,
    );

    const infoItems: InfoItem[] = [
        {
            label: t("recipient"),
            value: (
                <User
                    accountId={data.receiver}
                    displayAddress={displayReceiver}
                    chainName={recipientChainName}
                    withHoverCard
                    preferAddressBook
                />
            ),
        },
        {
            label: t("amount"),
            value: (
                <Amount
                    amount={data.amount}
                    tokenId={data.tokenId}
                    showUSDValue={data.usdValue !== null}
                    usdValue={data.usdValue ?? undefined}
                    showNetworkTooltip
                    usdTextOverride={amountUsdOverride}
                    nearFt={data.nearFt}
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
            value: (
                <FormattedAmount
                    kind="token"
                    value={data.networkFee!}
                    symbol={tokenData?.symbol || ""}
                    tokenDecimals={tokenData?.decimals}
                    unitPriceUsd={tokenData?.price}
                    profile="standard"
                    rounding="up"
                />
            ),
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
