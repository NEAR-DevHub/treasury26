"use client";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { BALANCE_MASK, useIsBalanceMasked } from "@/components/balance-mask";
import { Icon } from "@/components/icon";
import { NetworkIconDisplay } from "@/components/token-display";
import { TokenDisplay } from "@/components/token-display-with-network";
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Skeleton } from "@/components/ui/skeleton";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useToken } from "@/hooks/use-treasury-queries";
import {
    cn,
    formatBalance,
    formatCurrencyWithSubCent,
    formatTokenDisplayAmount,
} from "@/lib/utils";
import { useDestinationNetworkMeta } from "../../hooks/use-destination-network-meta";
import type { ConfidentialBulkData } from "../../types/index";
import {
    mapConfidentialBulkRecipientPayment,
    sumConfidentialBulkNetworkFee,
} from "../../utils/confidential-bulk-utils";
import { DetailRow, DetailsCard, RequestParty } from "./primitives";

type TokenData = ReturnType<typeof useToken>["data"];

/** The 28px ghost square the design puts at the end of every recipient row. */
const CHEVRON_CLASS =
    "flex size-7 shrink-0 items-center justify-center rounded-lg text-general-secondary-foreground [&_svg]:size-[13.25px]";

/**
 * The body of the details sheet for a bulk confidential payment: the total
 * being paid at the top, then the terms of the payment, then every recipient
 * it splits into. A recipient collapses to its share of the total and opens to
 * show who is being paid.
 */
export function BulkDetails({ data }: { data: ConfidentialBulkData }) {
    const t = useTranslations("proposals.expanded");
    const tIntents = useTranslations("intentsQuote");
    const isMasked = useIsBalanceMasked();

    const { data: tokenData } = useToken(data.tokenId);
    const {
        amountTokenId,
        recipientChainName,
        destinationNetworkMeta,
        shouldShowDestinationNetworkSkeleton,
    } = useDestinationNetworkMeta({
        destinationAssetId: data.destinationAssetId,
        originTokenId: data.tokenId,
        originNetwork: tokenData?.network || NEAR_NETWORK_ID,
        originChainIcons: tokenData?.chainIcons,
    });
    // Legs are quoted in the receive asset, so per-recipient amounts are read
    // through that token's decimals, icon and price rather than the origin's.
    const { data: amountToken } = useToken(amountTokenId);

    const totalAmount = formatBalance(
        data.totalAmount,
        tokenData?.decimals ?? 24,
    );
    const totalNumber = Number(totalAmount);
    const unitUsd = tokenData?.price ?? null;
    const totalUsd =
        unitUsd !== null && Number.isFinite(totalNumber)
            ? unitUsd * totalNumber
            : null;

    // The fee the DAO committed to at prepare time, summed across the legs —
    // already in token units, so it needs no decimal conversion.
    const networkFee = sumConfidentialBulkNetworkFee(data.recipients);

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
                            {isMasked
                                ? BALANCE_MASK
                                : formatTokenDisplayAmount(totalAmount)}
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
                {unitUsd !== null && tokenData && (
                    <DetailRow
                        label={t("rate")}
                        value={`1 ${tokenData.symbol} = ${formatCurrencyWithSubCent(unitUsd)}`}
                    />
                )}
                {networkFee.gt(0) && (
                    <DetailRow
                        label={t("networkFee")}
                        info={tIntents("networkFeeTooltip")}
                        value={`${
                            isMasked
                                ? BALANCE_MASK
                                : formatTokenDisplayAmount(networkFee.toFixed())
                        } ${tokenData?.symbol ?? ""}`.trim()}
                    />
                )}
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

                <RecipientList
                    recipients={data.recipients}
                    chainName={recipientChainName}
                    token={amountToken}
                />

                {data.notes && (
                    <DetailRow
                        label={t("note")}
                        align="start"
                        value={data.notes}
                    />
                )}
            </DetailsCard>
        </>
    );
}

/** The recipients the total splits into, one collapsible card each. */
function RecipientList({
    recipients,
    chainName,
    token,
}: {
    recipients: ConfidentialBulkData["recipients"];
    chainName: string;
    token: TokenData;
}) {
    const [openRecipients, setOpenRecipients] = useState<number[]>([]);

    return (
        <div className="flex flex-col gap-1">
            {recipients.map((recipient, index) => {
                const leg = mapConfidentialBulkRecipientPayment(
                    recipient.quoteMetadata,
                );
                return (
                    <Recipient
                        key={recipient.payloadHash || index}
                        number={index + 1}
                        accountId={leg.recipient}
                        chainName={chainName}
                        amount={formatBalance(
                            leg.amountOut,
                            token?.decimals ?? 24,
                        )}
                        token={token}
                        open={openRecipients.includes(index)}
                        onOpenChange={(open) =>
                            setOpenRecipients((prev) =>
                                open
                                    ? [...prev, index]
                                    : prev.filter((i) => i !== index),
                            )
                        }
                    />
                );
            })}
        </div>
    );
}

function Recipient({
    number,
    accountId,
    chainName,
    amount,
    token,
    open,
    onOpenChange,
}: {
    number: number;
    accountId: string;
    chainName: string;
    amount: string;
    token: TokenData;
    open: boolean;
    onOpenChange: (open: boolean) => void;
}) {
    const t = useTranslations("proposals.expanded");
    const isMasked = useIsBalanceMasked();

    const displayAmount = isMasked
        ? BALANCE_MASK
        : formatTokenDisplayAmount(amount);
    const amountLabel = `${displayAmount} ${token?.symbol ?? ""}`.trim();
    const amountNumber = Number(amount);
    const usd =
        token?.price && Number.isFinite(amountNumber)
            ? token.price * amountNumber
            : null;

    return (
        <Collapsible
            open={open}
            onOpenChange={onOpenChange}
            className="rounded-xl border border-general-border px-3 py-2"
        >
            <CollapsibleTrigger className="flex w-full items-center justify-between gap-2">
                <span className="text-sm font-medium leading-[1.5] text-general-secondary-foreground">
                    {t("recipientNumber", { number })}
                </span>
                <span className="flex items-center gap-1">
                    {!open && (
                        <span className="text-sm font-semibold leading-[1.5]">
                            {amountLabel}
                        </span>
                    )}
                    <span className={CHEVRON_CLASS}>
                        <Icon
                            icon={ArrowDown01Icon}
                            className={cn(
                                "transition-transform",
                                !open && "-rotate-90",
                            )}
                        />
                    </span>
                </span>
            </CollapsibleTrigger>
            <CollapsibleContent>
                <div className="flex items-center justify-between gap-2 py-2">
                    <RequestParty accountId={accountId} chainName={chainName} />
                    <div className="flex shrink-0 items-start gap-2">
                        {token && (
                            <TokenDisplay
                                symbol={token.symbol}
                                icon={token.icon ?? ""}
                                iconSize="md"
                                className="mt-0.5"
                            />
                        )}
                        <div className="flex flex-col items-end">
                            <span className="text-sm font-semibold leading-[1.5]">
                                {amountLabel}
                            </span>
                            {usd !== null && (
                                <span className="text-xs leading-4 tracking-[0.18px] text-general-secondary-foreground">
                                    {`≈ ${
                                        isMasked
                                            ? BALANCE_MASK
                                            : formatCurrencyWithSubCent(usd)
                                    }`}
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </CollapsibleContent>
        </Collapsible>
    );
}
