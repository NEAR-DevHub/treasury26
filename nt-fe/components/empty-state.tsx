import { cn } from "@/lib/utils";
import { isValidElement } from "react";
import { LucideIcon } from "lucide-react";

interface EmptyStateProps {
    icon?: LucideIcon | React.ReactNode;
    title: string;
    description: string;
    className?: string;
    iconWrapperClassName?: string;
    contentClassName?: string;
    titleClassName?: string;
    descriptionClassName?: string;
    skeleton?: React.ReactNode;
}

export function EmptyState({
    icon,
    title,
    description,
    className,
    iconWrapperClassName,
    contentClassName,
    titleClassName,
    descriptionClassName,
    skeleton,
}: EmptyStateProps) {
    const renderIcon = () => {
        if (isValidElement(icon)) return icon;
        const Icon = icon as LucideIcon;
        return <Icon className="size-5 text-muted-foreground" />;
    };

    const content = (
        <div
            className={cn(
                "flex flex-col gap-2 items-center justify-center py-12",
                className,
            )}
        >
            {icon ? (
                <div
                    className={cn(
                        "size-9 rounded-full bg-secondary flex items-center justify-center",
                        iconWrapperClassName,
                    )}
                >
                    {renderIcon()}
                </div>
            ) : null}
            <div
                className={cn(
                    "flex flex-col gap-0.5 items-center text-center",
                    contentClassName,
                )}
            >
                <p
                    className={cn(
                        "text-xl font-semibold leading-[1.2] tracking-[-0.025rem] text-foreground",
                        titleClassName,
                    )}
                >
                    {title}
                </p>
                <p
                    className={cn(
                        "text-sm font-medium leading-normal text-muted-foreground whitespace-pre-wrap",
                        descriptionClassName,
                    )}
                >
                    {description}
                </p>
            </div>
        </div>
    );

    if (!skeleton) return content;

    return (
        <div className="relative **:data-[slot=skeleton]:animate-none!">
            <div aria-hidden className="pointer-events-none select-none">
                {skeleton}
            </div>
            <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6">
                <div className="pointer-events-auto">{content}</div>
            </div>
        </div>
    );
}
