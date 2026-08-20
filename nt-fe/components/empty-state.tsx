import { cn } from "@/lib/utils";
import { isValidElement } from "react";
import { type IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/icon";

interface EmptyStateProps {
    icon: EmptyStateIcon;
    title: string;
    description: string;
    className?: string;
    iconWrapperClassName?: string;
    contentClassName?: string;
    titleClassName?: string;
    descriptionClassName?: string;
}

const ICON_CLASS_NAME = "size-5 text-muted-foreground";

type EmptyStateIcon = IconSvgElement | React.ReactNode;

// Hugeicons ship icons as plain svg data arrays, not components
const isHugeicon = (icon: EmptyStateIcon): icon is IconSvgElement =>
    Array.isArray(icon);

export function EmptyState({
    icon,
    title,
    description,
    className,
    iconWrapperClassName,
    contentClassName,
    titleClassName,
    descriptionClassName,
}: EmptyStateProps) {
    const renderIcon = () => {
        if (isValidElement(icon)) return icon;
        if (isHugeicon(icon))
            return <Icon icon={icon} className={ICON_CLASS_NAME} />;
        return icon;
    };

    return (
        <div
            className={cn(
                "flex flex-col gap-2 items-center justify-center py-12",
                className,
            )}
        >
            <div
                className={cn(
                    "size-9 rounded-full bg-secondary flex items-center justify-center",
                    iconWrapperClassName,
                )}
            >
                {renderIcon()}
            </div>
            <div
                className={cn(
                    "flex flex-col gap-0.5 items-center text-center",
                    contentClassName,
                )}
            >
                <p
                    className={cn(
                        "text-base font-semibold text-foreground",
                        titleClassName,
                    )}
                >
                    {title}
                </p>
                <p
                    className={cn(
                        "text-xs text-muted-foreground whitespace-pre-wrap",
                        descriptionClassName,
                    )}
                >
                    {description}
                </p>
            </div>
        </div>
    );
}
