"use client";

import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { BALANCE_MASK, useIsBalanceMasked } from "@/components/balance-mask";
import { Icon } from "@/components/icon";
import { NetworkIconDisplay } from "@/components/token-display";
import { TokenDisplay } from "@/components/token-display-with-network";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useQuoteByDepositAddress } from "@/hooks/use-proposals";
import { useToken } from "@/hooks/use-treasury-queries";
import {
    formatBalance,
    formatCurrencyWithSubCent,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { useDestinationNetworkMeta } from "../../hooks/use-destination-network-meta";
import type { PaymentRequestData } from "../../types/index";
import { useRequestDisplayContext } from "../expanded-view/common/request-display-context";
import { DetailRow, DetailsCard, RequestParty } from "./primitives";

/**
 * The body of the details sheet for a Send request: what is being paid at the
 * top, then who it goes to and what it costs.
 */
export function SendDetails({ data }: { data: PaymentRequestData }) {
    const t = useTranslations("proposals.expanded");
    const tIntents = useTranslations("intentsQuote");
    const isMasked = useIsBalanceMasked();
    const isExecuted = useRequestDisplayContext()?.isExecuted ?? false;

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
        nearComRoute: {
            depositAddress: data.depositAddress,
            quoteSignature: data.quoteSignature,
            networkFee: data.networkFee,
        },
    });

    // An executed intents payment only learns its settled USD value from the
    // quote, so it is fetched when the proposal doesn't already carry one.
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

    const rawAmount = formatBalance(data.amount, tokenData?.decimals ?? 24);
    const amountNumber = Number(rawAmount);
    const displayAmount = isMasked
        ? BALANCE_MASK
        : formatTokenDisplayAmount(rawAmount);

    // `usdValue: null` means the figure is deliberately withheld (confidential),
    // which is different from "we don't know it yet".
    const quoteUsd =
        data.quoteAmountInUsd ?? quoteByDepositAddress?.amountInUsd;
    const totalUsd =
        data.usdValue === null
            ? null
            : quoteUsd && !Number.isNaN(Number(quoteUsd))
              ? Number(quoteUsd)
              : (data.usdValue ??
                (tokenData?.price && Number.isFinite(amountNumber)
                    ? tokenData.price * amountNumber
                    : null));
    const unitUsd =
        data.usdValue === null
            ? null
            : (tokenData?.price ??
              (totalUsd !== null && amountNumber > 0
                  ? totalUsd / amountNumber
                  : null));

    return (
        <>
            <DetailsCard className="flex flex-col items-center justify-center gap-2.5 rounded-3xl p-4">
                {tokenData && (
                    <TokenDisplay
                        symbol={tokenData.symbol}
                        icon={tokenData.icon ?? ""}
                        iconSize="lg"
                        className="size-7"
                    />
                )}
                <div className="flex flex-col items-center gap-1">
                    <p className="flex items-end justify-center gap-[5px]">
                        <span className="text-lg font-semibold leading-6">
                            {displayAmount}
                        </span>
                        <span className="text-base font-medium leading-[1.2] text-general-muted-foreground">
                            {tokenData?.symbol}
                        </span>
                    </p>
                    {totalUsd !== null && (
                        <p className="text-sm font-semibold text-general-secondary-foreground">
                            {isMasked
                                ? BALANCE_MASK
                                : formatCurrencyWithSubCent(totalUsd)}
                        </p>
                    )}
                </div>
            </DetailsCard>

            <DetailsCard className="flex flex-col px-4 py-2">
                <DetailRow
                    label={t("recipient")}
                    value={
                        <RequestParty
                            accountId={data.receiver}
                            chainName={recipientChainName}
                        />
                    }
                />
                <DetailRow
                    label={t("destinationNetwork")}
                    value={
                        shouldShowDestinationNetworkSkeleton ? (
                            <Skeleton className="h-5 w-28" />
                        ) : (
                            <NetworkIconDisplay
                                chainIcons={destinationNetworkMeta.chainIcons}
                                networkName={destinationNetworkMeta.name}
                                className="gap-2"
                                iconClassName="size-5"
                            />
                        )
                    }
                />
                {unitUsd !== null && tokenData && (
                    <DetailRow
                        label={t("rate")}
                        value={`1 ${tokenData.symbol} = ${formatCurrencyWithSubCent(unitUsd)}`}
                    />
                )}
                {data.networkFee && (
                    <DetailRow
                        label={t("networkFee")}
                        info={tIntents("networkFeeTooltip")}
                        value={`${
                            isMasked
                                ? BALANCE_MASK
                                : formatTokenDisplayAmount(data.networkFee)
                        } ${tokenData?.symbol ?? ""}`.trim()}
                    />
                )}
                {data.notes && (
                    <DetailRow
                        label={t("note")}
                        align="start"
                        value={
                            data.url ? (
                                <Link
                                    href={data.url}
                                    target="_blank"
                                    className="flex items-start justify-end gap-2"
                                >
                                    <span>{data.notes}</span>
                                    <Icon
                                        icon={ArrowUpRight01Icon}
                                        className="mt-0.5 shrink-0"
                                    />
                                </Link>
                            ) : (
                                data.notes
                            )
                        }
                    />
                )}
            </DetailsCard>
        </>
    );
}
