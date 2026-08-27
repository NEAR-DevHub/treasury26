"use client";
import {
    ArrowDown01Icon,
    ArrowDown02Icon,
    ArrowRight01Icon,
    Contact01Icon,
} from "@hugeicons/core-free-icons";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { Address } from "@/components/address";
import { MaskedBalance } from "@/components/balance-mask";
import { Button } from "@/components/button";
import { FormattedDate } from "@/components/formatted-date";
import { Icon } from "@/components/icon";
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
import { Separator } from "@/components/ui/separator";
import { User } from "@/components/user";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";
import { useBulkPaymentTransactionHash } from "@/hooks/use-bulk-payment-transactions";
import { useMediaQuery } from "@/hooks/use-media-query";
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
    type BulkTransferRecipient,
    useBulkTransferRecipients,
} from "../hooks/use-bulk-transfer-recipients";
import {
    getActivityStatus,
    getFromAccountId,
    getToAccount,
    getToAccountId,
    isProposalMethodCall,
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
    transfer: "sendTransaction",
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
    token,
    amount,
    usdValue,
}: {
    token: Token;
    /** Already masked by the caller when it holds a figure rather than a status. */
    amount: ReactNode;
    usdValue?: number;
}) {
    return (
        <div className="flex flex-1 flex-col items-center gap-2 text-center">
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
                        ≈{" "}
                        <MaskedBalance>
                            {formatCurrency(usdValue)}
                        </MaskedBalance>
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
                amount={
                    <MaskedBalance>
                        {formatActivityAmount(activity.amount)}
                    </MaskedBalance>
                }
                usdValue={activity.valueUsd}
            />
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
 * Status, rate, date, contract call info and the transaction hash rows,
 * shared by every variant's detail list.
 */
function useDetailItems(
    activity: RecentActivity,
    variant: ActivityDetailsVariant,
): InfoItem[] {
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

    // Only governance calls surface their method/contract — a bulk transfer is
    // a FunctionCall too, but `ft_transfer_call` on the bulk payment contract
    // is protocol plumbing, not something the sender needs to read.
    if (isProposalMethodCall(activity)) {
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

    return items;
}

function DetailsSection({
    activity,
    variant,
}: {
    activity: RecentActivity;
    variant: ActivityDetailsVariant;
}) {
    const items = useDetailItems(activity, variant);

    return (
        <ModalSection className="rounded-t-[12px]">
            <InfoDisplay hideSeparator items={items} className="w-full" />
        </ModalSection>
    );
}

/**
 * Label / value rows for the deposit, send, bulk and swap dialogs: muted
 * label on the left, the value right-aligned and emphasised.
 */
function DetailRows({ items }: { items: InfoItem[] }) {
    return (
        <div className="flex w-full flex-col gap-2">
            {items.map((item) => (
                <div
                    key={item.label}
                    className="flex items-center justify-between gap-4 py-1"
                >
                    <p className="text-sm font-medium text-muted-foreground">
                        {item.label}
                    </p>
                    <div className="text-right text-sm font-semibold text-foreground">
                        {item.value}
                    </div>
                </div>
            ))}
        </div>
    );
}

/**
 * Headline of the deposit and send dialogs: the token, the signed amount and
 * its approximate USD value.
 */
function TokenAmountBlock({ activity }: { activity: RecentActivity }) {
    const token = activityToken(activity.tokenMetadata);

    return (
        <div className="flex items-center gap-3">
            <TokenDisplay
                symbol={token.symbol}
                icon={token.icon}
                iconSize="3xl"
            />
            <div className="flex min-w-0 flex-col">
                <span className="text-2xl leading-tight font-bold break-all text-foreground">
                    <MaskedBalance>
                        {formatActivityAmount(activity.amount)}
                    </MaskedBalance>{" "}
                    {token.symbol}
                </span>
                {activity.valueUsd ? (
                    <span className="text-base leading-tight font-medium break-all text-muted-foreground">
                        ≈{" "}
                        <MaskedBalance>
                            {formatCurrency(activity.valueUsd)}
                        </MaskedBalance>
                    </span>
                ) : null}
            </div>
        </div>
    );
}

/** The counterparty of a deposit or send: avatar, role label and account. */
function CounterpartyBlock({
    avatar,
    label,
    name,
    action,
}: {
    avatar: ReactNode;
    label: string;
    /** Omitted when the label already names the counterparty, e.g. bulk. */
    name?: string;
    /** Trailing control, e.g. the bulk recipients toggle. */
    action?: ReactNode;
}) {
    return (
        <div className="flex items-center gap-3 pl-1.5">
            {avatar}
            <div className="flex min-w-0 flex-1 flex-col">
                {name ? (
                    <>
                        <span className="text-base font-medium leading-tight text-muted-foreground">
                            {label}
                        </span>
                        <Address
                            address={name}
                            className="min-w-0 truncate text-base font-semibold leading-tight text-foreground"
                        />
                    </>
                ) : (
                    <span className="truncate text-base font-semibold leading-tight text-foreground">
                        {label}
                    </span>
                )}
            </div>
            {action}
        </div>
    );
}

function DownArrow() {
    return (
        <Icon
            icon={ArrowDown02Icon}
            className="ml-2 size-7 text-muted-foreground"
        />
    );
}

/**
 * Deposit dialog body: who sent the funds, what landed in the treasury, then
 * the detail rows — all on the dialog's single white surface.
 */
function DepositBody({
    activity,
    treasuryId,
}: {
    activity: RecentActivity;
    treasuryId: string;
}) {
    const t = useTranslations("activity.details");
    const getFromAccount = useGetFromAccount();
    const { isConfidential } = useTreasury();
    const items = useDetailItems(activity, "deposit");

    const fromAccountId = getFromAccountId(activity, true, treasuryId);
    const fromLabel = getFromAccount(
        activity,
        true,
        treasuryId,
        isConfidential,
    );

    return (
        <div className="flex flex-col gap-4 sm:px-5 sm:pb-5">
            <div className="flex flex-col gap-3">
                <CounterpartyBlock
                    avatar={
                        fromAccountId ? (
                            <User
                                accountId={fromAccountId}
                                variant="avatar"
                                size="md"
                            />
                        ) : null
                    }
                    label={t("from")}
                    name={fromLabel}
                />

                <DownArrow />

                <TokenAmountBlock activity={activity} />
            </div>

            <Separator className="bg-general-border" />

            <DetailRows items={items} />
        </div>
    );
}

/**
 * Send dialog body: what left the treasury, then where it went — the mirror
 * of the deposit layout.
 */
function SendBody({
    activity,
    treasuryId,
}: {
    activity: RecentActivity;
    treasuryId: string;
}) {
    const t = useTranslations("activity.details");
    const { isConfidential } = useTreasury();
    const items = useDetailItems(activity, "transfer");

    const toAccountId = getToAccountId(activity, false, treasuryId);
    const toLabel = getToAccount(activity, false, treasuryId, isConfidential);

    return (
        <div className="flex flex-col gap-4 sm:px-5 sm:pb-5">
            <div className="flex flex-col gap-3">
                <TokenAmountBlock activity={activity} />

                <DownArrow />

                <CounterpartyBlock
                    avatar={
                        toAccountId ? (
                            <User
                                accountId={toAccountId}
                                variant="avatar"
                                size="md"
                            />
                        ) : null
                    }
                    label={t("to")}
                    name={toLabel}
                />
            </div>

            <Separator className="bg-general-border" />

            <DetailRows items={items} />
        </div>
    );
}

/** Bulk payouts have no single counterparty to show an avatar for. */
function BulkRecipientsAvatar() {
    return (
        <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
            <Icon icon={Contact01Icon} className="size-4" />
        </div>
    );
}

/**
 * One payout of a bulk transfer: recipient, their share of the total, and the
 * transaction that settled it.
 */
function BulkRecipientCard({
    recipient,
    batchId,
    symbol,
}: {
    recipient: BulkTransferRecipient;
    batchId: string | null;
    symbol: string;
}) {
    const t = useTranslations("activity.details");
    const canLinkPayout = batchId != null && recipient.isPaid;
    const { data: payout } = useBulkPaymentTransactionHash(
        canLinkPayout ? batchId : null,
        canLinkPayout ? recipient.accountId : null,
    );

    return (
        <div className="flex flex-col gap-3 rounded-2xl border border-general-border p-4">
            <div className="flex items-center gap-3">
                <span className="min-w-0 flex-1 truncate text-base font-medium leading-tight text-foreground">
                    {recipient.accountId}
                </span>
                <div className="flex min-w-0 flex-col items-end">
                    <span className="truncate text-base font-semibold leading-tight text-foreground">
                        -<MaskedBalance>{recipient.amount}</MaskedBalance>{" "}
                        {symbol}
                    </span>
                    {recipient.valueUsd != null ? (
                        <span className="text-base font-medium leading-tight text-muted-foreground">
                            ≈{" "}
                            <MaskedBalance>
                                {formatCurrency(recipient.valueUsd)}
                            </MaskedBalance>
                        </span>
                    ) : null}
                </div>
            </div>

            {payout?.transactionHash ? (
                <div className="flex items-center justify-between gap-4 py-1">
                    <p className="text-sm font-medium text-muted-foreground">
                        {t("sendTransaction")}
                    </p>
                    <TransactionHashCell
                        transactionHashes={[payout.transactionHash]}
                        chainName={NEAR_NETWORK_ID}
                        className="flex items-center gap-2"
                    />
                </div>
            ) : null}
        </div>
    );
}

/**
 * Bulk transfer dialog body: the total that left the treasury, the recipients
 * it was split between, and — on demand — every individual payout.
 */
function BulkSendBody({
    activity,
    recipients,
    batchId,
}: {
    activity: RecentActivity;
    recipients: BulkTransferRecipient[];
    batchId: string | null;
}) {
    const t = useTranslations("activity.details");
    const [showRecipients, setShowRecipients] = useState(false);
    const items = useDetailItems(activity, "transfer");

    return (
        <div className="flex flex-col gap-4 sm:px-5 sm:pb-5">
            <div className="flex flex-col gap-3">
                <TokenAmountBlock activity={activity} />

                <DownArrow />

                <CounterpartyBlock
                    avatar={<BulkRecipientsAvatar />}
                    label={t("toRecipients", { count: recipients.length })}
                    action={
                        <Button
                            type="button"
                            variant="secondary"
                            size="icon"
                            aria-label={t(
                                showRecipients
                                    ? "hideRecipients"
                                    : "showRecipients",
                            )}
                            aria-expanded={showRecipients}
                            className="size-9 shrink-0 rounded-xl"
                            onClick={() => setShowRecipients((open) => !open)}
                        >
                            <Icon
                                icon={
                                    showRecipients
                                        ? ArrowDown01Icon
                                        : ArrowRight01Icon
                                }
                            />
                        </Button>
                    }
                />

                {showRecipients ? (
                    <div className="flex max-h-[302px] flex-col gap-2 overflow-y-auto">
                        {recipients.map((recipient) => (
                            <BulkRecipientCard
                                key={recipient.accountId}
                                recipient={recipient}
                                batchId={batchId}
                                symbol={activity.tokenMetadata.symbol}
                            />
                        ))}
                    </div>
                ) : null}
            </div>

            <Separator className="bg-general-border" />

            <DetailRows items={items} />
        </div>
    );
}

/**
 * One leg of a swap: token icon, the signed amount and its USD value.
 */
function SwapAmountRow({
    token,
    amount,
    usdValue,
}: {
    token: Token;
    /** Already masked by the caller when it holds a figure rather than a status. */
    amount: ReactNode;
    usdValue?: number;
}) {
    return (
        <div className="flex items-center gap-3">
            <TokenDisplay
                symbol={token.symbol}
                icon={token.icon}
                iconSize="3xl"
            />
            <div className="flex min-w-0 flex-col">
                <span className="text-2xl leading-tight font-bold break-all text-foreground">
                    {amount} {token.symbol}
                </span>
                {usdValue ? (
                    <span className="text-base leading-tight font-medium break-all text-muted-foreground">
                        <MaskedBalance>
                            {formatCurrency(usdValue)}
                        </MaskedBalance>
                    </span>
                ) : null}
            </div>
        </div>
    );
}

/**
 * Swap dialog body: the leg the treasury paid, the leg it got back, then the
 * detail rows — all on the dialog's single white surface.
 */
function SwapBody({
    activity,
    swap,
}: {
    activity: RecentActivity;
    swap: SwapInfo;
}) {
    const t = useTranslations("activity.details");
    const items = useDetailItems(activity, "exchange");

    const sentToken = swap.sentTokenMetadata
        ? activityToken(swap.sentTokenMetadata)
        : null;
    const receivedToken = activityToken(swap.receivedTokenMetadata);

    return (
        <div className="flex flex-col gap-4 sm:px-5 sm:pb-5">
            <div className="flex flex-col gap-3">
                {sentToken && swap.sentAmount ? (
                    <SwapAmountRow
                        token={sentToken}
                        amount={
                            <MaskedBalance>
                                {`-${formatSmartAmount(swap.sentAmount)}`}
                            </MaskedBalance>
                        }
                        usdValue={swap.sentAmountUsd}
                    />
                ) : null}

                <DownArrow />

                <SwapAmountRow
                    token={receivedToken}
                    amount={
                        swap.receivedAmount ? (
                            <MaskedBalance>
                                {`+${formatSmartAmount(swap.receivedAmount)}`}
                            </MaskedBalance>
                        ) : (
                            t("pending")
                        )
                    }
                    usdValue={swap.receivedAmountUsd}
                />
            </div>

            <Separator className="bg-general-border" />

            <DetailRows items={items} />
        </div>
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

/** Deposit and send share the single-surface dialog chrome. */
function TransferDialog({
    title,
    isOpen,
    onClose,
    children,
}: {
    title: string;
    isOpen: boolean;
    onClose: () => void;
    children: ReactNode;
}) {
    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="gap-3 bg-card sm:max-w-[448px]! sm:gap-3 sm:p-0">
                <DialogHeader className="mx-0 border-b-0 px-0 pb-0 sm:px-5 sm:pt-4">
                    <DialogTitle className="text-base">{title}</DialogTitle>
                </DialogHeader>

                {children}
            </DialogContent>
        </Dialog>
    );
}

/**
 * Send dialog. Batch payouts only reveal their recipients once the proposal
 * and the bulk payment list have loaded, so the layout resolves lazily.
 */
function SendDetailsDialog({
    activity,
    treasuryId,
    isOpen,
    onClose,
}: {
    activity: RecentActivity;
    treasuryId: string;
    isOpen: boolean;
    onClose: () => void;
}) {
    const t = useTranslations("activity.details");
    const bulk = useBulkTransferRecipients(activity, treasuryId);
    const isBulk = !!bulk?.recipients.length;

    return (
        <TransferDialog
            title={isBulk ? t("bulkTitle") : t("detailsTitle")}
            isOpen={isOpen}
            onClose={onClose}
        >
            {bulk && isBulk ? (
                <BulkSendBody
                    activity={activity}
                    recipients={bulk.recipients}
                    batchId={bulk.batchId}
                />
            ) : (
                <SendBody activity={activity} treasuryId={treasuryId} />
            )}

            {activity.proposalId != null ? (
                <ViewLinkedRequestButton
                    treasuryId={treasuryId}
                    proposalId={activity.proposalId}
                />
            ) : null}
        </TransferDialog>
    );
}

export function TransactionDetailsModal({
    activity,
    treasuryId,
    isOpen,
    onClose,
}: TransactionDetailsModalProps) {
    const t = useTranslations("activity.details");
    const isMobile = useMediaQuery("(max-width: 639px)");
    if (!activity) return null;

    const variant = getActivityDetailsVariant(activity);
    const isContractCall = isProposalCall(activity);
    const showParties = variant !== "exchange" && !isContractCall;

    // Deposits and swaps share the compact single-surface dialog.
    const compactBody = activity.swap ? (
        <SwapBody activity={activity} swap={activity.swap} />
    ) : variant === "deposit" ? (
        <DepositBody activity={activity} treasuryId={treasuryId} />
    ) : null;

    if (compactBody) {
        return (
            <TransferDialog
                title={t("detailsTitle")}
                isOpen={isOpen}
                onClose={onClose}
            >
                {compactBody}

                {activity.proposalId != null ? (
                    <ViewLinkedRequestButton
                        treasuryId={treasuryId}
                        proposalId={activity.proposalId}
                    />
                ) : null}
            </TransferDialog>
        );
    }

    // Governance calls keep the generic layout — there is no recipient or
    // amount for the send layout to lead with.
    if (variant === "transfer" && !isProposalMethodCall(activity)) {
        return (
            <SendDetailsDialog
                activity={activity}
                treasuryId={treasuryId}
                isOpen={isOpen}
                onClose={onClose}
            />
        );
    }

    return (
        <Dialog open={isOpen} onOpenChange={onClose}>
            <DialogContent className="gap-0 bg-card sm:max-w-[448px]! sm:gap-0.5 sm:bg-muted sm:p-0">
                <DialogHeader className="mx-0 border-b-0 bg-card px-0 py-3 sm:px-4 sm:py-3.5">
                    <DialogTitle>
                        {isMobile ? t("detailsTitle") : t(TITLE_KEYS[variant])}
                    </DialogTitle>
                </DialogHeader>

                <TokenAmountHeader activity={activity} />

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
