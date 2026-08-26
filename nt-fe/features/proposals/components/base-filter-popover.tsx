"use client";

import { Icon } from "@/components/icon";
import { Delete01Icon } from "@hugeicons/core-free-icons";
import { ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { OperationSelect } from "@/components/operation-select";
import { cn } from "@/lib/utils";

interface BaseFilterPopoverProps {
    filterLabel: string;
    operation: string;
    operations: string[];
    onOperationChange: (operation: string) => void;
    /** Omit to hide the "Clear" action — filters whose body can be emptied
     * on its own (token, from/to) don't show one in the design. */
    onClear?: () => void;
    onDelete: () => void;
    children: ReactNode;
    className?: string;
}

export function BaseFilterPopover({
    filterLabel,
    operation,
    operations,
    onOperationChange,
    onClear,
    onDelete,
    children,
    className,
}: BaseFilterPopoverProps) {
    const tF = useTranslations("requests.filters");
    return (
        <div className={cn("flex w-full flex-col", className)}>
            <div className="flex items-center justify-between gap-3 p-2">
                <div className="flex items-center gap-1">
                    <span className="text-general-muted-foreground text-sm">
                        {filterLabel}
                    </span>
                    <OperationSelect
                        operations={operations}
                        selectedOperation={operation}
                        onOperationChange={onOperationChange}
                    />
                </div>
                <div className="flex items-center gap-2">
                    {onClear && (
                        <Button
                            variant="ghost"
                            size="sm"
                            onClick={onClear}
                            className="text-general-unofficial-ghost-foreground h-7 rounded-sm px-2 text-xs font-bold"
                        >
                            {tF("clear")}
                        </Button>
                    )}
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onDelete}
                        className="text-general-unofficial-ghost-foreground size-7 rounded-sm"
                    >
                        <Icon icon={Delete01Icon} className="size-3.5" />
                    </Button>
                </div>
            </div>

            {children}
        </div>
    );
}
