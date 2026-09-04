"use client";

import { useTranslations } from "next-intl";
import {
    SelectModal,
    type SelectOption,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { SelectListIcon } from "@/components/select-list";
import {
    SelectorOptionBalance,
    SelectorOptionLabels,
} from "@/components/selector-option-row";
import { getNetworkDisplayName } from "@/components/token-display";
import { getNetworkDisplayCaseClass } from "@/lib/intents-network";
import { formatCurrencyWithSubCent, formatSmartAmount } from "@/lib/utils";

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
        <SelectorOptionBalance
            primary={formatSmartAmount(amount)}
            secondary={`≈${
                Number.isFinite(balance.amountUSD)
                    ? formatCurrencyWithSubCent(balance.amountUSD)
                    : formatCurrencyWithSubCent(0)
            }`}
        />
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
                    <SelectorOptionLabels
                        primary={getNetworkDisplayName(
                            item.name || item.symbol || "",
                        )}
                        secondary={description}
                        highlightQuery={searchQuery}
                        primaryClassName={getNetworkDisplayCaseClass(item.name)}
                    />
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
