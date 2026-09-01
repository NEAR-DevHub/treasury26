"use client";

import { ReactNode, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
    SelectModal,
    type SelectOption,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { HighlightedText } from "@/components/highlighted-text";
import { SelectListIcon } from "@/components/select-list";
import { getNetworkDisplayName } from "@/components/token-display";
import { getNetworkDisplayCaseClass } from "@/lib/intents-network";
import { cn, formatCurrencyWithSubCent, formatSmartAmount } from "@/lib/utils";

export type NetworkBalanceDisplay = {
    amount: string | number;
    amountUSD: number;
};

export type NetworkSelectSection = {
    title: string;
    options: SelectOption[];
    display?: "list" | "chips";
};

export interface NetworkSelectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (option: SelectOption) => void;
    onBack?: () => void;
    title: string;
    searchPlaceholder?: string;
    isLoading?: boolean;
    selectedId?: string;
    options: SelectOption[];
    sections?: NetworkSelectSection[];
    /** When true, show balance from balancesById (deposit-style). */
    showBalance?: boolean;
    balancesById?: Map<string, NetworkBalanceDisplay>;
    /** Prefer localized network name in the primary row. Default true. */
    useNetworkDisplayName?: boolean;
    renderRight?: (item: SelectOption) => ReactNode;
    renderContent?: (
        item: SelectOption,
        context: { searchQuery: string },
    ) => ReactNode;
}

function DefaultNetworkBalance({
    balance,
}: {
    balance: NetworkBalanceDisplay;
}) {
    const amount = balance.amount.toString();
    const numeric = Number(amount);
    const isZero =
        (!Number.isFinite(numeric) && /^0+(\.0+)?$/.test(amount)) ||
        (Number.isFinite(numeric) && numeric <= 0);
    if (isZero) return null;

    return (
        <div className="flex flex-col items-end">
            <span className="font-semibold">{formatSmartAmount(amount)}</span>
            <span className="text-sm text-muted-foreground">
                ≈
                {Number.isFinite(balance.amountUSD)
                    ? formatCurrencyWithSubCent(balance.amountUSD)
                    : formatCurrencyWithSubCent(0)}
            </span>
        </div>
    );
}

/**
 * Network-only picker. Deposit passes showBalance + balancesById; Send
 * destination can omit balances and supply custom sections/content.
 */
export function NetworkSelectModal({
    isOpen,
    onClose,
    onSelect,
    onBack,
    title,
    searchPlaceholder,
    isLoading = false,
    selectedId,
    options,
    sections,
    showBalance = false,
    balancesById,
    useNetworkDisplayName = true,
    renderRight,
    renderContent,
}: NetworkSelectModalProps) {
    const tSelect = useTranslations("selectModal");

    const resolvedRenderContent =
        renderContent ??
        ((item: SelectOption, { searchQuery }: { searchQuery: string }) => {
            // Match deposit's prior labeling: display-name + HighlightedText on
            // search; keep raw description highlighted when present.
            const networkLabel = useNetworkDisplayName
                ? getNetworkDisplayName(item.name || item.symbol || "")
                : item.name || item.symbol || "";
            const description = (
                item as SelectOption & { description?: string }
            ).description;
            return (
                <div className="flex-1 text-left">
                    <div
                        className={cn(
                            "font-semibold",
                            getNetworkDisplayCaseClass(item.name),
                        )}
                    >
                        <HighlightedText
                            text={networkLabel}
                            query={searchQuery}
                        />
                    </div>
                    {description ? (
                        <div className="text-xs text-muted-foreground font-normal">
                            <HighlightedText
                                text={description}
                                query={searchQuery}
                            />
                        </div>
                    ) : null}
                </div>
            );
        });

    const resolvedRenderRight =
        renderRight ??
        (showBalance
            ? (item: SelectOption) => {
                  const balance = balancesById?.get(item.id);
                  if (!balance) return null;
                  return <DefaultNetworkBalance balance={balance} />;
              }
            : undefined);

    const modalSections = useMemo(() => sections, [sections]);

    return (
        <SelectModal
            isOpen={isOpen}
            onClose={onClose}
            onBack={onBack}
            title={title}
            searchPlaceholder={searchPlaceholder ?? tSelect("searchByName")}
            isLoading={isLoading}
            selectedId={selectedId}
            options={options}
            sections={modalSections}
            onSelect={onSelect}
            renderIcon={(item) => (
                <SelectListIcon
                    icon={item.icon}
                    alt={item.name || item.symbol || ""}
                />
            )}
            renderContent={resolvedRenderContent}
            renderRight={resolvedRenderRight}
        />
    );
}
