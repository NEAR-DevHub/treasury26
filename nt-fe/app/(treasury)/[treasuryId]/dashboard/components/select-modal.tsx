"use client";

import { useState, useMemo, useCallback, ReactNode } from "react";
import { Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { Input } from "@/components/input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { Button } from "@/components/button";
import {
    SelectListIcon,
    SelectListItem,
    SelectListSkeleton,
} from "@/components/select-list";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

export interface SelectOption extends SelectListItem {}

interface SelectModalPropsBase {
    isOpen: boolean;
    onClose: () => void;
    title: string;
    options: SelectOption[];
    searchPlaceholder?: string;
    isLoading?: boolean;
    renderIcon?: (item: SelectOption) => ReactNode;
    renderContent?: (item: SelectOption) => ReactNode;
    renderRight?: (item: SelectOption) => ReactNode;
    sections?: {
        title: string;
        options: SelectOption[];
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

    const filteredOptions = useMemo(() => {
        if (!searchQuery) return options;

        const query = searchQuery.toLowerCase();
        return options.filter(
            (option) =>
                (option.name || "").toLowerCase().includes(query) ||
                (option.symbol || "").toLowerCase().includes(query),
        );
    }, [options, searchQuery]);

    const filteredSections = useMemo(() => {
        if (!sections?.length) return [];

        return sections
            .map((section) => {
                if (!searchQuery) return section;

                const query = searchQuery.toLowerCase();
                const sectionOptions = section.options.filter(
                    (option) =>
                        (option.name || "").toLowerCase().includes(query) ||
                        (option.symbol || "").toLowerCase().includes(query),
                );

                return {
                    ...section,
                    options: sectionOptions,
                };
            })
            .filter((section) => section.options.length > 0);
    }, [sections, searchQuery]);

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
                <Check className="size-4 text-primary shrink-0" />
            ) : null;
        },
        [renderRight, multiSelect, selectedIds],
    );

    const renderOptionRow = useCallback(
        (item: SelectOption) => (
            <Button
                key={item.id}
                onClick={() => handleSelect(item)}
                variant="ghost"
                disabled={item.disabled}
                className={cn(
                    "w-full flex items-center gap-1 py-2.5 rounded-lg h-auto justify-start pl-1.5! mx-1 my-0.5",
                    selectedId === item.id
                        ? "bg-muted hover:bg-muted focus-visible:bg-muted"
                        : "hover:bg-muted-foreground/5 focus-visible:bg-muted-foreground/5",
                    item.disabled &&
                        "opacity-60 cursor-not-allowed pointer-events-none",
                )}
            >
                {renderIcon ? (
                    renderIcon(item)
                ) : (
                    <SelectListIcon
                        icon={item.icon}
                        gradient={item.gradient}
                        alt={item.symbol || item.name}
                    />
                )}
                {renderContent ? (
                    renderContent(item)
                ) : (
                    <div className="flex-1 text-left">
                        <div className="font-semibold uppercase">
                            {item.name || item.symbol}
                        </div>
                        {item.symbol && (
                            <div className="text-sm text-muted-foreground ">
                                {item.symbol}
                            </div>
                        )}
                    </div>
                )}
                {resolvedRenderRight(item)}
            </Button>
        ),
        [
            handleSelect,
            renderContent,
            renderIcon,
            resolvedRenderRight,
            selectedId,
        ],
    );

    return (
        <Dialog open={isOpen} onOpenChange={(open) => !open && handleClose()}>
            <DialogContent className="max-w-md">
                <DialogHeader centerTitle>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>

                <div className="space-y-4">
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
                        <ScrollArea className="h-[400px]">
                            {sections?.length ? (
                                filteredSections.length > 0 ? (
                                    filteredSections.map((section) => (
                                        <div
                                            key={section.title}
                                            className="mb-4 last:mb-0"
                                        >
                                            <div className="text-xs font-medium text-muted-foreground uppercase px-2 py-2">
                                                {section.title}
                                            </div>
                                            {section.options.map(
                                                renderOptionRow,
                                            )}
                                        </div>
                                    ))
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
