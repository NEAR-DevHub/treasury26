"use client";

import { ReactNode, useMemo } from "react";
import { useTranslations } from "next-intl";
import {
    SelectModal,
    type SelectOption,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { HighlightedText } from "@/components/highlighted-text";
import { SelectListIcon } from "@/components/select-list";
import type { MergedToken } from "@/hooks/use-merged-tokens";
import { formatCurrencyWithSubCent, formatSmartAmount } from "@/lib/utils";

export type TokenBalanceLayout = "usdPrimary" | "tokenPrimary" | "none";

export type TokenSelectSection = {
    title: string;
    tokens: MergedToken[];
    display?: "list" | "chips";
};

export type TokenOptionSection = {
    title: string;
    options: SelectOption[];
    display?: "list" | "chips";
};

type TokenSelectModalMergedProps = {
    mode?: "merged";
    tokens?: MergedToken[];
    sections?: TokenSelectSection[];
    onSelect: (token: MergedToken) => void;
    optionSections?: never;
    options?: never;
    balancesById?: never;
    onSelectOption?: never;
};

type TokenSelectModalOptionProps = {
    mode: "options";
    options: SelectOption[];
    optionSections?: TokenOptionSection[];
    balancesById?: Map<string, { balance: string; balanceUSD: number }>;
    onSelectOption: (option: SelectOption) => void;
    onSelect?: never;
    tokens?: never;
    sections?: never;
};

export type TokenSelectModalProps = {
    isOpen: boolean;
    onClose: () => void;
    title?: string;
    searchPlaceholder?: string;
    isLoading?: boolean;
    selectedId?: string;
    showBalance?: boolean;
    balanceLayout?: TokenBalanceLayout;
    showNetworksCount?: boolean;
} & (TokenSelectModalMergedProps | TokenSelectModalOptionProps);

function tokenToOption(token: MergedToken): SelectOption {
    return {
        id: token.id,
        name: token.name || token.symbol,
        symbol: token.symbol,
        icon: token.icon || token.symbol?.charAt(0) || "?",
    };
}

function TokenBalanceRight({
    balance,
    balanceUSD,
    layout,
}: {
    balance: number | string;
    balanceUSD: number;
    layout: TokenBalanceLayout;
}) {
    if (layout === "none") return null;
    const numeric =
        typeof balance === "number" ? balance : Number.parseFloat(balance);
    if (!(numeric > 0)) return null;

    if (layout === "usdPrimary") {
        return (
            <div className="flex flex-col items-end">
                <span className="font-semibold">
                    {formatCurrencyWithSubCent(balanceUSD)}
                </span>
                <span className="text-sm text-muted-foreground">
                    {formatSmartAmount(balance)}
                </span>
            </div>
        );
    }

    return (
        <div className="flex flex-col items-end">
            <span className="font-semibold">{formatSmartAmount(balance)}</span>
            <span className="text-sm text-muted-foreground">
                ≈{formatCurrencyWithSubCent(balanceUSD)}
            </span>
        </div>
    );
}

/**
 * Asset-only token picker built on SelectModal. Callers own network /
 * origin-leg resolution separately.
 *
 * - `mode: "merged"` (default): Send-style MergedToken lists
 * - `mode: "options"`: Deposit-style SelectOption + balance maps
 */
export function TokenSelectModal(props: TokenSelectModalProps) {
    const {
        isOpen,
        onClose,
        title,
        searchPlaceholder,
        isLoading = false,
        selectedId,
        showBalance = true,
        balanceLayout = "tokenPrimary",
        showNetworksCount = false,
    } = props;

    const t = useTranslations("tokenSelectDialog");
    const tSelect = useTranslations("selectModal");
    const isOptionsMode = props.mode === "options";

    const tokenById = useMemo(() => {
        const map = new Map<string, MergedToken>();
        if (isOptionsMode) return map;
        for (const token of props.tokens ?? []) map.set(token.id, token);
        for (const section of props.sections ?? []) {
            for (const token of section.tokens) map.set(token.id, token);
        }
        return map;
    }, [isOptionsMode, props]);

    const options = useMemo(() => {
        if (isOptionsMode) return props.options;
        return (props.tokens ?? []).map(tokenToOption);
    }, [isOptionsMode, props]);

    const modalSections = useMemo(() => {
        if (isOptionsMode) {
            if (!props.optionSections?.length) return undefined;
            return props.optionSections
                .filter((s) => s.options.length > 0)
                .map((section) => ({
                    title: section.title,
                    display: section.display,
                    options: section.options,
                }));
        }
        if (!props.sections?.length) return undefined;
        return props.sections
            .filter((s) => s.tokens.length > 0)
            .map((section) => ({
                title: section.title,
                display: section.display,
                options: section.tokens.map(tokenToOption),
            }));
    }, [isOptionsMode, props]);

    const renderContent = !isOptionsMode
        ? (
              item: SelectOption,
              { searchQuery }: { searchQuery: string },
          ): ReactNode => {
              const token = tokenById.get(item.id);
              const secondaryName =
                  item.symbol && item.name && item.name !== item.symbol
                      ? item.name
                      : null;
              return (
                  <div className="flex-1 text-left min-w-0">
                      <div className="font-semibold truncate">
                          <HighlightedText
                              text={item.symbol || item.name}
                              query={searchQuery}
                          />
                      </div>
                      {showNetworksCount && token ? (
                          <div className="text-sm text-muted-foreground truncate">
                              {t("networksCount", {
                                  count: token.networks.length,
                              })}
                          </div>
                      ) : secondaryName ? (
                          <div className="text-sm text-muted-foreground truncate">
                              <HighlightedText
                                  text={secondaryName}
                                  query={searchQuery}
                              />
                          </div>
                      ) : null}
                  </div>
              );
          }
        : undefined;

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
            onSelect={(option) => {
                if (isOptionsMode) {
                    props.onSelectOption(option);
                    return;
                }
                const token = tokenById.get(option.id);
                if (token) props.onSelect(token);
            }}
            renderIcon={(item) => (
                <SelectListIcon
                    icon={item.icon}
                    alt={item.symbol || item.name}
                />
            )}
            renderContent={renderContent}
            renderRight={
                showBalance
                    ? (item) => {
                          if (isOptionsMode) {
                              const balanceData = props.balancesById?.get(
                                  item.id,
                              );
                              if (!balanceData) return null;
                              return (
                                  <TokenBalanceRight
                                      balance={balanceData.balance}
                                      balanceUSD={balanceData.balanceUSD}
                                      layout={balanceLayout}
                                  />
                              );
                          }
                          const token = tokenById.get(item.id);
                          if (!token) return null;
                          return (
                              <TokenBalanceRight
                                  balance={token.totalBalance ?? 0}
                                  balanceUSD={token.totalBalanceUSD ?? 0}
                                  layout={balanceLayout}
                              />
                          );
                      }
                    : undefined
            }
        />
    );
}
