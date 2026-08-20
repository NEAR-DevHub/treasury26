"use client";
import { ArrowDown02Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { FormattedDate } from "@/components/formatted-date";
import { Icon } from "@/components/icon";
import { NearIntentsLogo } from "@/components/icons/near-intents-logo";
import { InfoDisplay, type InfoItem } from "@/components/info-display";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { TokenDisplay } from "@/components/token-display-with-network";
import type { Token } from "@/components/token-input";
import { Tooltip } from "@/components/tooltip";
import { User } from "@/components/user";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useTreasury } from "@/hooks/use-treasury";
import type { RecentActivity, SwapInfo, TokenMetadataInfo } from "@/lib/api";
import Big from "@/lib/big";
import {
    cn,
    formatActivityAmount,
    formatCurrency,
    formatCurrencyWithSubCent,
    formatSmartAmount,
} from "@/lib/utils";
import {
    getActivityStatus,
    getFromAccountId,
    getToAccount,
    getToAccountId,
    useGetFromAccount,
} from "../utils/history-utils";
import { ActivityStatusPill } from "./activity-status-pill";
import { TransactionHashCell } from "./transaction-hash-cell";

type ActivityDetailsVariant = "deposit" | "exchange" | "transfer";

const TITLE_KEYS: Record<ActivityDetailsVariant, string> = {
    deposit: "depositTitle",
    exchange: "exchangeTitle",
    transfer: "transferTitle",
};

const TRANSACTION_LABEL_KEYS: Record<ActivityDetailsVariant, string> = {
    deposit: "depositTransaction",
    exchange: "exchangeTransaction",
    transfer: "transferTransaction",
};

interface TransactionDetailsModalProps {
    activity: RecentActivity | null;
    treasuryId: string;
    isOpen: boolean;
    onClose: () => void;
}

function getActivityDetailsVariant(
    activity: RecentActivity,
): ActivityDetailsVariant {
    if (activity.swap) return "exchange";
    return parseFloat(activity.amount) > 0 ? "deposit" : "transfer";
}

function isProposalCall(activity: RecentActivity): boolean {
    return activity.actionKind === "FunctionCall" && !!activity.methodName;
}

/**
 * Single-token USD rate ("1 NEAR = $2.65"), same format as the request
 * receipt page. Prefers the activity's own USD valuation over the current
 * token price.
 */
function tokenRateLabel(activity: RecentActivity): string | null {
    const symbol = activity.tokenMetadata?.symbol;
    if (!symbol) return null;

    const amount = Math.abs(parseFloat(activity.amount));
    const unitPrice =
        activity.valueUsd && amount > 0
            ? activity.valueUsd / amount
            : activity.tokenMetadata?.price;
    if (!unitPrice) return null;

    return `1 ${symbol} = ${formatCurrencyWithSubCent(unitPrice)}`;
}

interface ExchangeRateDetails {
    unitAmount: string;
    sentSymbol: string;
    receivedPerSent: string;
    receivedSymbol: string;
    sentUnitUsd: number | null;
    receivedUnitUsd: number | null;
}

function swapUnitUsdPrice(
    amount: string,
    amountUsd?: number,
    fallbackPrice?: number,
): number | null {
    try {
        const parsedAmount = Big(amount);
        if (
            parsedAmount.gt(0) &&
            amountUsd != null &&
            Number.isFinite(amountUsd) &&
            amountUsd > 0
        ) {
            const unitPrice = Big(amountUsd.toString())
                .div(parsedAmount)
                .toNumber();
            if (Number.isFinite(unitPrice) && unitPrice > 0) return unitPrice;
        }
    } catch {
        // Fall through to the token metadata price.
    }

    return fallbackPrice != null &&
        Number.isFinite(fallbackPrice) &&
        fallbackPrice > 0
        ? fallbackPrice
        : null;
}

function exchangeRateDetails(swap: SwapInfo): ExchangeRateDetails | null {
    if (!swap.sentAmount || !swap.receivedAmount || !swap.sentTokenMetadata) {
        return null;
    }

    try {
        const sentAmount = Big(swap.sentAmount);
        const receivedAmount = Big(swap.receivedAmount);
        if (sentAmount.lte(0) || receivedAmount.lte(0)) return null;

        return {
            unitAmount: formatSmartAmount(1),
            sentSymbol: swap.sentTokenMetadata.symbol,
            receivedPerSent: formatSmartAmount(receivedAmount.div(sentAmount)),
            receivedSymbol: swap.receivedTokenMetadata.symbol,
            sentUnitUsd: swapUnitUsdPrice(
                swap.sentAmount,
                swap.sentAmountUsd,
                swap.sentTokenMetadata.price,
            ),
            receivedUnitUsd: swapUnitUsdPrice(
                swap.receivedAmount,
                swap.receivedAmountUsd,
                swap.receivedTokenMetadata.price,
            ),
        };
    } catch {
        return null;
    }
}

function ExchangeRateValue({ details }: { details: ExchangeRateDetails }) {
    const rate = (
        <span>
            {details.unitAmount} {details.sentSymbol} ≈{" "}
            {details.receivedPerSent} {details.receivedSymbol}
        </span>
    );

    if (details.sentUnitUsd == null && details.receivedUnitUsd == null) {
        return rate;
    }

    return (
        <Tooltip
            side="right"
            content={
                <div className="flex flex-col gap-1 whitespace-nowrap">
                    {details.sentUnitUsd != null ? (
                        <p>
                            {details.unitAmount} {details.sentSymbol} ={" "}
                            {formatCurrencyWithSubCent(details.sentUnitUsd)}
                        </p>
                    ) : null}
                    {details.receivedUnitUsd != null ? (
                        <p>
                            {details.unitAmount} {details.receivedSymbol} ={" "}
                            {formatCurrencyWithSubCent(details.receivedUnitUsd)}
                        </p>
                    ) : null}
                </div>
            }
        >
            <button type="button" className="text-right">
                {rate}
            </button>
        </Tooltip>
    );
}

function activityToken(metadata: TokenMetadataInfo): Token {
    return {
        address: metadata.tokenId,
        symbol: metadata.symbol,
        decimals: metadata.decimals,
        name: metadata.name,
        icon: metadata.icon || "",
        network: metadata.network || NEAR_NETWORK_ID,
        chainIcons: metadata.chainIcons,
    };
}

/**
 * White surface block for one modal section. The dialog's muted background
 * shows through the gaps between stacked sections.
 */
function ModalSection({
    className,
    children,
}: {
    className?: string;
    children: React.ReactNode;
}) {
    return (
        <div
            className={cn(
                "flex w-full flex-col items-start gap-2.5 self-stretch bg-card px-0 py-3 sm:px-4",
                className,
            )}
        >
            {children}
        </div>
    );
}

function TokenAmountColumn({
    title,
    token,
    amount,
    usdValue,
}: {
    title?: string;
    token: Token;
    amount: string;
    usdValue?: number;
}) {
    return (
        <div className="flex flex-1 flex-col items-center gap-2 text-center">
            {title ? (
                <p className="text-xs font-medium text-muted-foreground">
                    {title}
                </p>
            ) : null}
            <TokenDisplay
                symbol={token.symbol}
                icon={token.icon}
                chainIcons={token.chainIcons}
                iconSize="xl"
            />
            <div className="flex flex-col gap-0.5">
                <p className="text-lg font-semibold text-foreground break-all">
                    {amount}{" "}
                    <span className="text-muted-foreground font-medium text-xs">
                        {token.symbol}
                    </span>
                </p>
                {usdValue ? (
                    <p className="text-xxs text-muted-foreground break-all">
                        ≈ {formatCurrency(usdValue)}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

/**
 * Centered token icon with signed amount and approximate USD value,
 * shown for deposits and transfers.
 */
function TokenAmountHeader({ activity }: { activity: RecentActivity }) {
    return (
        <ModalSection className="items-center py-8 rounded-b-[12px]">
            <TokenAmountColumn
                token={activityToken(activity.tokenMetadata)}
                amount={formatActivityAmount(activity.amount)}
                usdValue={activity.valueUsd}
            />
        </ModalSection>
    );
}

/**
 * Sell / receive summary for exchanges.
 */
function ExchangeSummarySection({ swap }: { swap: SwapInfo }) {
    const t = useTranslations("activity.details");
    const sentToken = swap.sentTokenMetadata
        ? activityToken(swap.sentTokenMetadata)
        : null;
    const receivedToken = activityToken(swap.receivedTokenMetadata);

    return (
        <>
            <div className="flex flex-col gap-3 bg-card py-3 sm:hidden">
                {sentToken && swap.sentAmount ? (
                    <MobileSwapTokenRow
                        token={sentToken}
                        amount={formatSmartAmount(swap.sentAmount)}
                        usdValue={swap.sentAmountUsd}
                    />
                ) : null}
                <Icon
                    icon={ArrowDown02Icon}
                    className="mx-auto size-4 text-muted-foreground"
                />
                <MobileSwapTokenRow
                    token={receivedToken}
                    amount={
                        swap.receivedAmount
                            ? formatSmartAmount(swap.receivedAmount)
                            : t("pending")
                    }
                    usdValue={swap.receivedAmountUsd}
                />
            </div>
            <ModalSection className="hidden py-6 rounded-b-[12px] sm:flex">
                <div className="relative flex w-full items-center justify-center gap-4">
                    {swap.sentAmount && swap.sentTokenMetadata ? (
                        <TokenAmountColumn
                            title={t("sell")}
                            token={activityToken(swap.sentTokenMetadata)}
                            amount={formatSmartAmount(swap.sentAmount)}
                            usdValue={swap.sentAmountUsd}
                        />
                    ) : null}

                    <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
                        <div className="rounded-full bg-card border p-1.5 shadow-sm">
                            <Icon
                                icon={ArrowRight01Icon}
                                className="text-muted-foreground"
                            />
                        </div>
                    </div>

                    <TokenAmountColumn
                        title={t("receive")}
                        token={activityToken(swap.receivedTokenMetadata)}
                        amount={
                            swap.receivedAmount
                                ? formatSmartAmount(swap.receivedAmount)
                                : t("pending")
                        }
                        usdValue={swap.receivedAmountUsd}
                    />
                </div>
            </ModalSection>
        </>
    );
}

function MobileSwapTokenRow({
    token,
    amount,
    usdValue,
}: {
    token: Token;
    amount: string;
    usdValue?: number;
}) {
    return (
        <div className="flex items-center gap-3">
            <TokenDisplay
                symbol={token.symbol}
                icon={token.icon}
                chainIcons={token.chainIcons}
                iconSize="xl"
            />
            <div className="min-w-0">
                <p className="font-semibold text-xl leading-tight text-foreground">
                    {amount} {token.symbol}
                </p>
                {usdValue ? (
                    <p className="text-sm text-muted-foreground">
                        {formatCurrency(usdValue)}
                    </p>
                ) : null}
            </div>
        </div>
    );
}

function ViaIntentsSection() {
    const t = useTranslations("activity.details");

    return (
        <ModalSection className="hidden rounded-[12px] sm:flex">
            <p className="text-sm text-muted-foreground">{t("via")}</p>
            <NearIntentsLogo className="h-3" />
        </ModalSection>
    );
}

function AccountIdentity({
    accountId,
    fallbackLabel,
}: {
    accountId: string | null;
    fallbackLabel: string;
}) {
    if (!accountId) {
        return <span className="text-sm font-medium">{fallbackLabel}</span>;
    }
    return (
        <User accountId={accountId} useAddressBook withHoverCard size="md" />
    );
}

function PartyRow({
    label,
    accountId,
    fallbackLabel,
}: {
    label: string;
    accountId: string | null;
    fallbackLabel: string;
}) {
    return (
        <div className="space-y-2">
            <p className="text-sm text-muted-foreground">{label}</p>
            <AccountIdentity
                accountId={accountId}
                fallbackLabel={fallbackLabel}
            />
        </div>
    );
}

/**
 * From / to accounts for deposits and transfers.
 */
function PartiesSection({
    activity,
    treasuryId,
}: {
    activity: RecentActivity;
    treasuryId: string;
}) {
    const t = useTranslations("activity.details");
    const getFromAccount = useGetFromAccount();
    const { isConfidential } = useTreasury();

    const isReceived = parseFloat(activity.amount) > 0;
    const fromAccountId = getFromAccountId(activity, isReceived, treasuryId);
    const toAccountId = getToAccountId(activity, isReceived, treasuryId);
    const fromLabel = getFromAccount(
        activity,
        isReceived,
        treasuryId,
        isConfidential,
    );
    const toLabel = getToAccount(
        activity,
        isReceived,
        treasuryId,
        isConfidential,
    );

    return (
        <ModalSection className="gap-4 rounded-[12px]">
            <PartyRow
                label={t("from")}
                accountId={fromAccountId}
                fallbackLabel={fromLabel}
            />
            <PartyRow
                label={t("to")}
                accountId={toAccountId}
                fallbackLabel={toLabel}
            />
        </ModalSection>
    );
}

/**
 * Status, date, contract call info and the transaction hash rows.
 */
function DetailsSection({
    activity,
    variant,
}: {
    activity: RecentActivity;
    variant: ActivityDetailsVariant;
}) {
    const t = useTranslations("activity.details");

    const items: InfoItem[] = [
        {
            label: t("status"),
            value: <ActivityStatusPill status={getActivityStatus(activity)} />,
        },
    ];
    if (variant === "exchange" && activity.swap) {
        const rate = exchangeRateDetails(activity.swap);
        if (rate) {
            items.push({
                label: t("rate"),
                value: <ExchangeRateValue details={rate} />,
            });
        }
    } else {
        const rate = tokenRateLabel(activity);
        if (rate) {
            items.push({ label: t("rate"), value: rate });
        }
    }
    items.push({
        label: t("date"),
        value: (
            <FormattedDate date={new Date(activity.blockTime)} includeTime />
        ),
    });

    if (isProposalCall(activity)) {
        items.push(
            { label: t("method"), value: activity.methodName },
            {
                label: t("contract"),
                value: (
                    <AccountIdentity
                        accountId={activity.receiverId || activity.counterparty}
                        fallbackLabel="N/A"
                    />
                ),
            },
        );
    }

    if (activity.transactionHashes?.length || activity.receiptIds?.length) {
        items.push({
            label: t(TRANSACTION_LABEL_KEYS[variant]),
            value: (
                <TransactionHashCell
                    transactionHashes={activity.transactionHashes}
                    receiptIds={activity.receiptIds}
                    chainName={activity.tokenMetadata?.chainName}
                    className="flex items-center gap-2"
                />
            ),
        });
    }

    return (
        <ModalSection className="rounded-t-[12px]">
            <InfoDisplay hideSeparator items={items} className="w-full" />
        </ModalSection>
    );
}

function ViewLinkedRequestButton({
    treasuryId,
    proposalId,
}: {
    treasuryId: string;
    proposalId: number;
}) {
    const t = useTranslations("activity.details");

    return (
        <ModalSection>
            <Button
                asChild
                variant="secondary"
                className="h-9 w-full rounded-[8px] font-medium sm:rounded-[8px] max-sm:rounded-xl max-sm:bg-muted max-sm:text-foreground"
            >
                <Link
                    href={`/${treasuryId}/requests/${proposalId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                >
                    {t("linkedRequest")}
                    <Icon icon={ArrowRight01Icon} />
                </Link>
            </Button>
        </ModalSection>
    );
}

export function TransactionDetailsModal({
    activity,
    treasuryId,
    isOpen,
    onClose,
}: TransactionDetailsModalProps) {
    const t = useTranslations("activity.details");
    if (!activity) return null;

    const variant = getActivityDetailsVariant(activity);
    const showParties = variant !== "exchange" && !isProposalCall(activity);

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="gap-0 bg-card sm:max-w-[448px]! sm:gap-0.5 sm:bg-muted sm:p-0">
                <DialogHeader className="mx-0 border-b-0 bg-card px-0 py-3 sm:px-4 sm:py-3.5">
                    <DialogTitle>
                        <span className="sm:hidden">{t("detailsTitle")}</span>
                        <span className="hidden sm:inline">
                            {t(TITLE_KEYS[variant])}
                        </span>
                    </DialogTitle>
                </DialogHeader>

                {variant === "exchange" && activity.swap ? (
                    <ExchangeSummarySection swap={activity.swap} />
                ) : (
                    <TokenAmountHeader activity={activity} />
                )}

                {variant === "exchange" ? <ViaIntentsSection /> : null}
                {showParties ? (
                    <PartiesSection
                        activity={activity}
                        treasuryId={treasuryId}
                    />
                ) : null}

                <DetailsSection activity={activity} variant={variant} />

                {activity.proposalId != null ? (
                    <ViewLinkedRequestButton
                        treasuryId={treasuryId}
                        proposalId={activity.proposalId}
                    />
                ) : null}
            </DialogContent>
        </Dialog>
    );
}
