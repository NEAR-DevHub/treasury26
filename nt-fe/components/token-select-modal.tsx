"use client";

import { useTranslations } from "next-intl";
import { useMemo } from "react";
import {
    SelectModal,
    type SelectOption,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { SelectListIcon } from "@/components/select-list";
import { SelectorOptionBalance } from "@/components/selector-option-row";
import { formatCurrencyWithSubCent, formatSmartAmount } from "@/lib/utils";

type TokenOptionSection = {
    title: string;
    options: SelectOption[];
    display?: "list" | "chips";
};

type TokenSelectModalProps = {
    isOpen: boolean;
    onClose: () => void;
    onSelectOption: (option: SelectOption) => void;
    options: SelectOption[];
    optionSections?: TokenOptionSection[];
    balancesById?: Map<string, { balance: string; balanceUSD: number }>;
    title?: string;
    searchPlaceholder?: string;
    isLoading?: boolean;
    selectedId?: string;
    showBalance?: boolean;
};

function TokenBalanceRight({
    balance,
    balanceUSD,
}: {
    balance: number | string;
    balanceUSD: number;
}) {
    const numeric =
        typeof balance === "number" ? balance : Number.parseFloat(balance);
    if (!(numeric > 0)) return null;

    return (
        <SelectorOptionBalance
            primary={formatSmartAmount(balance)}
            secondary={`≈${formatCurrencyWithSubCent(balanceUSD)}`}
        />
    );
}

/**
 * Asset-only token picker built on SelectModal. Callers own network /
 * origin-leg resolution separately.
 */
export function TokenSelectModal({
    isOpen,
    onClose,
    onSelectOption,
    options,
    optionSections,
    balancesById,
    title,
    searchPlaceholder,
    isLoading = false,
    selectedId,
    showBalance = true,
}: TokenSelectModalProps) {
    const t = useTranslations("tokenSelectDialog");
    const tSelect = useTranslations("selectModal");

    const modalSections = useMemo(
        () =>
            optionSections?.length
                ? optionSections.filter((section) => section.options.length > 0)
                : undefined,
        [optionSections],
    );

    return (
        <SelectModal
            isOpen={isOpen}
            onClose={onClose}
            title={title ?? t("selectToken")}
            searchPlaceholder={searchPlaceholder ?? tSelect("searchByName")}
            isLoading={isLoading}
            selectedId={selectedId}
            options={options}
            sections={modalSections}
            onSelect={onSelectOption}
            renderIcon={(item) => (
                <SelectListIcon
                    icon={item.icon}
                    alt={item.symbol || item.name}
                />
            )}
            renderRight={
                showBalance
                    ? (item) => {
                          const balanceData = balancesById?.get(item.id);
                          if (!balanceData) return null;
                          return (
                              <TokenBalanceRight
                                  balance={balanceData.balance}
                                  balanceUSD={balanceData.balanceUSD}
                              />
                          );
                      }
                    : undefined
            }
        />
    );
}
