import { Check, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface StepIconProps {
    status: "Success" | "Pending" | "Failed" | "Expired";
    size?: "sm" | "md";
}

const sizeClass = {
    sm: "size-4",
    md: "size-6",
};

const iconClass = {
    sm: "size-3",
    md: "size-4",
};

export function StepIcon({ status, size = "md" }: StepIconProps) {
    switch (status) {
        case "Success":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-general-success-foreground",
                        sizeClass[size],
                    )}
                >
                    <Check
                        className={cn(iconClass[size], "text-white shrink-0")}
                    />
                </div>
            );
        case "Pending":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full border border-muted-foreground/20 bg-card",
                        sizeClass[size],
                    )}
                />
            );
        case "Expired":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-secondary",
                        sizeClass[size],
                    )}
                >
                    <X
                        className={cn(
                            iconClass[size],
                            "text-muted-foreground shrink-0",
                        )}
                    />
                </div>
            );
        case "Failed":
            return (
                <div
                    className={cn(
                        "flex shrink-0 items-center justify-center rounded-full bg-general-destructive-foreground",
                        sizeClass[size],
                    )}
                >
                    <X className={cn(iconClass[size], "text-white shrink-0")} />
                </div>
            );
    }
}
