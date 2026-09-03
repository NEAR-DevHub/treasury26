"use client";

import { Icon } from "@/components/icon";
import { ArrowLeft01Icon, CheckIcon } from "@hugeicons/core-free-icons";
import { useState, useMemo, useCallback, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/input";
import { Dialog, DialogHeader, DialogTitle } from "@/components/modal";
import { Button } from "@/components/button";
import { PaymentSelectModalContent } from "@/components/payment-select-modal-content";
import {
    getSelectOptionLabels,
    SelectListIcon,
    SelectListItem,
    SelectListSkeleton,
} from "@/components/select-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
    paymentSelectModalListClassName,
    paymentSelectModalSearchInputClassName,
} from "@/components/selector-field";
import { cn } from "@/lib/utils";
import { HighlightedText } from "@/components/highlighted-text";
import { PopularTokenTiles } from "@/components/popular-token-tiles";

export interface SelectOption extends SelectListItem {}

export type SelectModalRenderContext = {
    searchQuery: string;
};

interface SelectModalPropsBase {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    options: SelectOption[];
    searchPlaceholder?: string;
    isLoading?: boolean;
    onBack?: () => void;
    renderIcon?: (
        item: SelectOption,
        context: SelectModalRenderContext,
    ) => ReactNode;
    renderContent?: (
        item: SelectOption,
        context: SelectModalRenderContext,
    ) => ReactNode;
    renderRight?: (item: SelectOption) => ReactNode;
    sections?: {
        title: string;
        options: SelectOption[];
        display?: "list" | "chips";
    }[];
}

interface SelectModalSingleProps extends SelectModalPropsBase {
    multiSelect?: false;
    onSelect: (option: SelectOption) => void;
    selectedId?: string;
    selectedIds?: never;
}

interface SelectModalMultiProps extends SelectModalPropsBase {
    multiSelect: true;
    onSelect: (option: SelectOption) => void;
    selectedIds: string[];
    selectedId?: string;
}

type SelectModalProps = SelectModalSingleProps | SelectModalMultiProps;

function optionMatchesSearch(option: SelectOption, query: string): boolean {
    if (!query) return true;
    return (
        (option.name || "").toLowerCase().includes(query) ||
        (option.symbol || "").toLowerCase().includes(query)
    );
}

export function SelectModal({
    isOpen,
    onClose,
    onSelect,
    onBack,
    title,
    options,
    searchPlaceholder,
    isLoading = false,
    selectedId,
    selectedIds,
    multiSelect,
    renderIcon,
    renderContent,
    renderRight,
    sections,
}: SelectModalProps) {
    const t = useTranslations("selectModal");
    const [searchQuery, setSearchQuery] = useState("");
    const effectiveSearchPlaceholder = searchPlaceholder ?? t("searchByName");
    const normalizedQuery = searchQuery.toLowerCase();

    const filteredOptions = useMemo(() => {
        if (!normalizedQuery) return options;
        return options.filter((option) =>
            optionMatchesSearch(option, normalizedQuery),
        );
    }, [options, normalizedQuery]);

    const filteredSections = useMemo(() => {
        if (!sections?.length) return [];

        return sections
            .map((section) => ({
                ...section,
                options: normalizedQuery
                    ? section.options.filter((option) =>
                          optionMatchesSearch(option, normalizedQuery),
                      )
                    : section.options,
            }))
            .filter((section) => section.options.length > 0);
    }, [sections, normalizedQuery]);

    const handleSelect = useCallback(
        (option: SelectOption) => {
            onSelect(option);
            if (!multiSelect) {
                setSearchQuery("");
                onClose();
            }
        },
        [onSelect, onClose, multiSelect],
    );

    const handleClose = useCallback(() => {
        setSearchQuery("");
        onClose();
    }, [onClose]);

    const resolvedRenderRight = useCallback(
        (item: SelectOption) => {
            if (renderRight) return renderRight(item);
            if (!multiSelect) return null;
            return selectedIds?.includes(item.id) ? (
                <Icon icon={CheckIcon} className="text-primary shrink-0" />
            ) : null;
        },
        [renderRight, multiSelect, selectedIds],
    );

    const renderContext = useMemo(() => ({ searchQuery }), [searchQuery]);

    const renderOptionRow = useCallback(
        (item: SelectOption) => {
            const { primary, secondary } = getSelectOptionLabels(item);

            return (
                <Button
                    key={item.id}
                    onClick={() => handleSelect(item)}
                    variant="ghost"
                    disabled={item.disabled}
                    className={cn(
                        "w-full flex items-center gap-1 py-2.5 rounded-xl h-auto justify-start pl-1.5! mx-1 my-0.5",
                        selectedId === item.id
                            ? "bg-muted hover:bg-muted focus-visible:bg-muted"
                            : "hover:bg-muted-foreground/5 focus-visible:bg-muted-foreground/5",
                        item.disabled &&
                            "opacity-60 cursor-not-allowed pointer-events-none",
                    )}
                >
                    {renderIcon ? (
                        renderIcon(item, renderContext)
                    ) : (
                        <SelectListIcon
                            icon={item.icon}
                            gradient={item.gradient}
                            alt={item.symbol || item.name}
                        />
                    )}
                    {renderContent ? (
                        renderContent(item, renderContext)
                    ) : (
                        <div className="flex-1 text-left">
                            <div className="font-semibold">
                                <HighlightedText
                                    text={primary}
                                    query={searchQuery}
                                />
                            </div>
                            {secondary && (
                                <div className="text-sm text-muted-foreground">
                                    <HighlightedText
                                        text={secondary}
                                        query={searchQuery}
                                    />
                                </div>
                            )}
                        </div>
                    )}
                    {resolvedRenderRight(item)}
                </Button>
            );
        },
        [
            handleSelect,
            renderContent,
            renderContext,
            renderIcon,
            resolvedRenderRight,
            searchQuery,
            selectedId,
        ],
    );

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <PaymentSelectModalContent>
                <DialogHeader
                    centerTitle={false}
                    className="sticky top-0 border-0 pb-0 text-left"
                >
                    <div className="flex items-center gap-2">
                        {onBack && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={onBack}
                                className="h-8 w-8 shrink-0"
                                aria-label={t("back")}
                            >
                                <Icon icon={ArrowLeft01Icon} />
                            </Button>
                        )}
                        <DialogTitle className="text-left text-lg font-semibold flex-1">
                            {title}
                        </DialogTitle>
                    </div>
                </DialogHeader>

                <div className="mt-4 flex min-h-0 flex-1 flex-col space-y-4 sm:mt-0">
                    <Input
                        type="text"
                        search
                        placeholder={effectiveSearchPlaceholder}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                        inputClassName={paymentSelectModalSearchInputClassName}
                    />

                    {isLoading ? (
                        <SelectListSkeleton />
                    ) : (
                        <ScrollArea className={paymentSelectModalListClassName}>
                            {sections?.length ? (
                                filteredSections.length > 0 ? (
                                    filteredSections.map((section) => {
                                        if (section.display === "chips") {
                                            return (
                                                <div
                                                    key={section.title}
                                                    className="mb-3"
                                                >
                                                    <div className="px-2 py-2 text-sm text-muted-foreground">
                                                        {section.title}
                                                    </div>
                                                    <PopularTokenTiles
                                                        items={section.options}
                                                        searchQuery={
                                                            searchQuery
                                                        }
                                                        onSelect={handleSelect}
                                                        isItemSelected={(
                                                            item,
                                                        ) =>
                                                            selectedId ===
                                                            item.id
                                                        }
                                                    />
                                                </div>
                                            );
                                        }

                                        return (
                                            <div key={section.title}>
                                                <div className="text-xs font-medium text-muted-foreground px-2 py-2">
                                                    {section.title}
                                                </div>
                                                {section.options.map(
                                                    renderOptionRow,
                                                )}
                                            </div>
                                        );
                                    })
                                ) : (
                                    <div className="text-center py-8 text-muted-foreground">
                                        {t("noResults")}
                                    </div>
                                )
                            ) : filteredOptions.length > 0 ? (
                                filteredOptions.map(renderOptionRow)
                            ) : (
                                <div className="text-center py-8 text-muted-foreground">
                                    {t("noResults")}
                                </div>
                            )}
                        </ScrollArea>
                    )}
                </div>
            </PaymentSelectModalContent>
        </Dialog>
    );
}
