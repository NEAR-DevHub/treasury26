import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";
import { Info } from "lucide-react";

interface InputBlockProps {
    title?: string;
    info?: string;
    topRightContent?: React.ReactNode;
    children: React.ReactNode;
    invalid: boolean;
    className?: string;
    interactive?: boolean;
    disabled?: boolean;
}

export function InputBlock({
    children,
    title,
    info,
    topRightContent,
    invalid,
    interactive,
    className,
    disabled,
}: InputBlockProps) {
    return (
        <div
            className={cn(
                "px-3.5 py-3 rounded-xl bg-muted",
                "dark:[&_input]:bg-transparent! dark:[&_textarea]:bg-transparent! dark:**:data-[slot=select-trigger]:bg-transparent!",
                invalid && "border-destructive border bg-destructive/5",
                interactive &&
                    !disabled &&
                    "focus-within:bg-general-unofficial-ghost-hover hover:bg-general-unofficial-ghost-hover transition-colors",
                disabled && "opacity-50 pointer-events-none",
                className,
            )}
        >
            <div className="flex justify-between items-center gap-2">
                <div className="flex items-center gap-1">
                    {title && (
                        <p className="text-xs text-muted-foreground">{title}</p>
                    )}
                    {info && (
                        <Tooltip content={info}>
                            <Info className="size-3 text-muted-foreground" />
                        </Tooltip>
                    )}
                </div>
                {topRightContent}
            </div>
            {children}
        </div>
    );
}
