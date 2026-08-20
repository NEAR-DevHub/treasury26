"use client";

import { Icon } from "@/components/icon";
import { Cancel01Icon, Delete01Icon } from "@hugeicons/core-free-icons";
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
    onClear: () => void;
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
        <div className={cn("w-full pb-1.5 flex flex-col", className)}>
            <div className="flex px-2 pt-1 h-[35px] gap-3 justify-between items-baseline">
                <div className="flex items-baseline gap-1">
                    <span className="text-xs  text-muted-foreground">
                        {filterLabel}
                    </span>
                    <OperationSelect
                        operations={operations}
                        selectedOperation={operation}
                        onOperationChange={onOperationChange}
                    />
                </div>
                <div className="flex w-full items-center flex-1 ml-auto">
                    <Button
                        variant="ghost"
                        size="sm"
                        onClick={onClear}
                        className="ml-auto text-muted-foreground hover:text-foreground h-7 px-1.5"
                    >
                        {tF("clear")}
                    </Button>
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={onDelete}
                        className="text-muted-foreground hover:text-foreground h-7 w-7"
                    >
                        <Icon icon={Delete01Icon} />
                    </Button>
                </div>
            </div>

            {children}
        </div>
    );
}
