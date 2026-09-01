"use client";

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

type NetworkBalanceDisplay = {
    amount: string | number;
    amountUSD: number;
};

type NetworkSelectSection = {
    title: string;
    options: SelectOption[];
    display?: "list" | "chips";
};

interface NetworkSelectModalProps {
    isOpen: boolean;
    onClose: () => void;
    onSelect: (option: SelectOption) => void;
    title: string;
    searchPlaceholder?: string;
    isLoading?: boolean;
    selectedId?: string;
    options: SelectOption[];
    sections?: NetworkSelectSection[];
    /** When true, show balance from balancesById (deposit-style). */
    showBalance?: boolean;
    balancesById?: Map<string, NetworkBalanceDisplay>;
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

/** Network-only picker. Deposit passes showBalance + balancesById. */
export function NetworkSelectModal({
    isOpen,
    onClose,
    onSelect,
    title,
    searchPlaceholder,
    isLoading = false,
    selectedId,
    options,
    sections,
    showBalance = false,
    balancesById,
}: NetworkSelectModalProps) {
    const tSelect = useTranslations("selectModal");

    return (
        <SelectModal
            isOpen={isOpen}
            onClose={onClose}
            title={title}
            searchPlaceholder={searchPlaceholder ?? tSelect("searchByName")}
            isLoading={isLoading}
            selectedId={selectedId}
            options={options}
            sections={sections}
            onSelect={onSelect}
            renderIcon={(item) => (
                <SelectListIcon
                    icon={item.icon}
                    alt={item.name || item.symbol || ""}
                />
            )}
            renderContent={(item, { searchQuery }) => {
                // Match deposit's prior labeling: display-name +
                // HighlightedText on search; keep raw description highlighted
                // when present.
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
                                text={getNetworkDisplayName(
                                    item.name || item.symbol || "",
                                )}
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
            }}
            renderRight={
                showBalance
                    ? (item) => {
                          const balance = balancesById?.get(item.id);
                          if (!balance) return null;
                          return <DefaultNetworkBalance balance={balance} />;
                      }
                    : undefined
            }
        />
    );
}
