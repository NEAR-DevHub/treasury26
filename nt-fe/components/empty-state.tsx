import { cn } from "@/lib/utils";
import { LucideIcon } from "lucide-react";

interface EmptyStateProps {
    icon: LucideIcon;
    title: string;
    description: string;
    className?: string;
}

export function EmptyState({
    icon: Icon,
    title,
    description,
    className,
}: EmptyStateProps) {
    return (
        <div
            className={cn(
                "flex flex-col gap-2 items-center justify-center py-12",
                className,
            )}
        >
            <div className="size-9 rounded-full bg-secondary flex items-center justify-center">
                <Icon className="size-5 text-muted-foreground" />
            </div>
            <div className="flex flex-col gap-0.5 items-center text-center">
                <p className="text-base font-semibold text-foreground">
                    {title}
                </p>
                <p className="text-xs text-muted-foreground">{description}</p>
            </div>
        </div>
    );
}
