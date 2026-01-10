"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

export type Operation = string;

interface OperationSelectProps {
    operations: Operation[];
    selectedOperation: Operation;
    onOperationChange: (operation: Operation) => void;
    className?: string;
}

export function OperationSelect({
    operations,
    selectedOperation,
    onOperationChange,
    className,
}: OperationSelectProps) {
    const [isOpen, setIsOpen] = useState(false);

    return (
        <Popover open={isOpen} onOpenChange={setIsOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    className={cn(
                        "gap-1 px-1.5! w-fit h-5 items-center bg-card hover:bg-card border-0 text-[10px]",
                        className
                    )}
                >
                    <span className="font-medium">{selectedOperation}</span>
                    <ChevronDown className="h-3 w-3 text-muted-foreground" />
                </Button>
            </PopoverTrigger>
            <PopoverContent className="w-fit p-1 min-w-32" align="start">
                <div className="flex flex-col">
                    {operations.map((operation) => (
                        <Button
                            key={operation}
                            variant="ghost"
                            size="sm"
                            className={cn(
                                "justify-start font-normal h-8 text-[10px]",
                                selectedOperation === operation && "bg-muted"
                            )}
                            onClick={() => {
                                onOperationChange(operation);
                                setIsOpen(false);
                            }}
                        >
                            {operation}
                        </Button>
                    ))}
                </div>
            </PopoverContent>
        </Popover>
    );
}
