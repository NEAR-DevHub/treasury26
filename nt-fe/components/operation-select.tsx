"use client";

import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/button";
import { Icon } from "@/components/icon";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type Operation = string;

interface OperationSelectProps {
    operations: Operation[];
    selectedOperation: Operation;
    onOperationChange: (operation: Operation) => void;
    className?: string;
}

const OPERATION_TRANSLATION_KEYS: Record<string, string> = {
    Is: "is",
    "Is Not": "isNot",
    Before: "before",
    After: "after",
    Between: "between",
    Equal: "equal",
    "More Than": "moreThan",
    "Less Than": "lessThan",
    Contains: "contains",
};

/**
 * Translates a filter operation ("Is Not") into the viewer's language. Shared
 * with the mobile filter sheet, which spells the operation out in its heading
 * instead of hiding it behind a popover.
 */
export function useOperationLabel() {
    const t = useTranslations("filterOperations");

    return (operation: Operation) => {
        const key = OPERATION_TRANSLATION_KEYS[operation];
        return key ? t(key) : operation;
    };
}

export function OperationSelect({
    operations,
    selectedOperation,
    onOperationChange,
    className,
}: OperationSelectProps) {
    const labelFor = useOperationLabel();
    const [isOpen, setIsOpen] = useState(false);
    if (operations.length <= 1) {
        return null;
    }

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className={cn(
                        "text-muted-foreground h-5 w-fit items-center gap-1 rounded-[3.5px] px-1.5! text-xs",
                        className,
                    )}
                >
                    <span className="font-medium">
                        {labelFor(selectedOperation)}
                    </span>
                    <Icon icon={ArrowDown01Icon} className="size-4" />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className="border-general-border w-fit min-w-32 rounded-xl p-1.5"
                align="start"
            >
                <div className="flex flex-col gap-0.5">
                    {operations.map((operation) => (
                        <Button
                            key={operation}
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "text-muted-foreground h-8 justify-start rounded-lg px-4 text-sm font-semibold",
                                selectedOperation === operation && "bg-muted",
                            )}
                            onClick={() => {
                                onOperationChange(operation);
                                setIsOpen(false);
                            }}
                        >
                            {labelFor(operation)}
                        </Button>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}
