import { Check } from "lucide-react";
import { Button } from "@/components/button";
import { cn } from "@/lib/utils";

export interface SelectableOption {
    label: string;
    iconSrc?: string;
    iconClassName?: string;
    iconImageClassName?: string;
}

interface SelectableOptionButtonProps {
    option: SelectableOption;
    selected: boolean;
    indicatorType?: "checkbox" | "radio";
    onClick: () => void;
}

export function SelectableOptionButton({
    option,
    selected,
    indicatorType = "checkbox",
    onClick,
}: SelectableOptionButtonProps) {
    const iconSrc = option.iconSrc;

    return (
        <Button
            type="button"
            variant="unstyled"
            onClick={onClick}
            className={cn(
                "w-full rounded-lg border px-3 py-1.5 h-auto justify-between items-start hover:bg-general-secondary/30",
                selected
                    ? "border-foreground bg-general-secondary"
                    : "border-input",
            )}
        >
            <div className="flex items-center gap-2.5 min-w-0">
                {iconSrc ? (
                    <div className="size-5 shrink-0">
                        <img
                            src={iconSrc}
                            alt={option.label}
                            className={cn(
                                "w-full h-full object-cover",
                                option.iconImageClassName,
                            )}
                        />
                    </div>
                ) : option.iconClassName ? (
                    <div
                        className={cn(
                            "size-5 rounded-full grid place-content-center text-xs font-semibold shrink-0",
                            option.iconClassName,
                        )}
                    />
                ) : null}
                <span className="text-sm font-normal text-foreground whitespace-normal wrap-break-word text-left leading-snug">
                    {option.label}
                </span>
            </div>
            {indicatorType === "radio" ? (
                <div
                    className={cn(
                        "size-5 rounded-full border grid place-content-center shrink-0 border-general-unofficial-border-3",
                        selected ? "bg-transparent" : "bg-input/30",
                    )}
                >
                    <div
                        className={cn(
                            "size-2 rounded-full",
                            selected ? "bg-foreground" : "bg-transparent",
                        )}
                    />
                </div>
            ) : (
                <div
                    className={cn(
                        "size-5 rounded-md border grid place-content-center shrink-0",
                        selected
                            ? "bg-foreground border-foreground text-background"
                            : "bg-muted/30 border-input text-transparent",
                    )}
                >
                    <Check className="size-3.5" />
                </div>
            )}
        </Button>
    );
}
