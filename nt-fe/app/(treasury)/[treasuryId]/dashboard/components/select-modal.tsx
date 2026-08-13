"use client";

import { Icon } from "@/components/icon";
import { CheckIcon } from "@hugeicons/core-free-icons";
import { useState, useMemo, useCallback, ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/input";
import { SheetHandle } from "@/components/mobile-shell/sheet-handle";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Button } from "@/components/button";
import {
    getSelectOptionLabels,
    SelectListIcon,
    SelectListItem,
    SelectListSkeleton,
} from "@/components/select-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { HighlightedText } from "@/components/highlighted-text";

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
            <DialogContent className="max-h-[90vh] gap-0 overflow-hidden p-4 sm:max-w-md sm:gap-4">
                <div className="-mb-2 sm:hidden">
                    <SheetHandle />
                </div>
                <DialogHeader
                    centerTitle={false}
                    closeButton={false}
                    className="border-0 px-0 pb-0 text-left -mx-0 sticky top-0 sm:border-b sm:border-border sm:-mx-4 sm:px-4 sm:pb-3.5"
                >
                    <DialogTitle className="text-left text-lg font-semibold">
                        {title}
                    </DialogTitle>
                </DialogHeader>

                <div className="mt-4 space-y-4 min-h-0 flex-1 flex flex-col sm:mt-0">
                    <Input
                        type="text"
                        search
                        placeholder={effectiveSearchPlaceholder}
                        value={searchQuery}
                        onChange={(e) => setSearchQuery(e.target.value)}
                    />

                    {isLoading ? (
                        <SelectListSkeleton />
                    ) : (
                        <ScrollArea className="h-[min(560px,calc(90vh-11rem))]">
                            {sections?.length ? (
                                filteredSections.length > 0 ? (
                                    filteredSections.map((section) => {
                                        if (section.display === "chips") {
                                            return (
                                                <div
                                                    key={section.title}
                                                    className="mb-3"
                                                >
                                                    <div className="text-xs font-medium text-muted-foreground px-2 py-2">
                                                        {section.title}
                                                    </div>
                                                    <div className="px-1 flex flex-wrap gap-2">
                                                        {section.options.map(
                                                            (item) => (
                                                                <Button
                                                                    key={
                                                                        item.id
                                                                    }
                                                                    onClick={() =>
                                                                        handleSelect(
                                                                            item,
                                                                        )
                                                                    }
                                                                    variant="secondary"
                                                                    disabled={
                                                                        item.disabled
                                                                    }
                                                                    className={cn(
                                                                        "h-8 rounded-full px-2.5 py-1 text-sm font-medium gap-1.5",
                                                                        selectedId ===
                                                                            item.id &&
                                                                            "bg-muted",
                                                                        item.disabled &&
                                                                            "opacity-60 cursor-not-allowed pointer-events-none",
                                                                    )}
                                                                >
                                                                    <SelectListIcon
                                                                        icon={
                                                                            item.icon
                                                                        }
                                                                        gradient={
                                                                            item.gradient
                                                                        }
                                                                        alt={
                                                                            item.symbol ||
                                                                            item.name
                                                                        }
                                                                        size="sm"
                                                                    />
                                                                    <HighlightedText
                                                                        text={
                                                                            item.symbol ||
                                                                            item.name ||
                                                                            ""
                                                                        }
                                                                        query={
                                                                            searchQuery
                                                                        }
                                                                    />
                                                                </Button>
                                                            ),
                                                        )}
                                                    </div>
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
            </DialogContent>
        </Dialog>
    );
}
