import { cn } from "@/lib/utils";
import { isValidElement } from "react";
import { type IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/icon";

type EmptyStateIcon = IconSvgElement | React.ReactNode;

interface EmptyStateProps {
    icon?: EmptyStateIcon;
    title: string;
    description: string;
    className?: string;
    iconWrapperClassName?: string;
    contentClassName?: string;
    titleClassName?: string;
    descriptionClassName?: string;
    skeleton?: React.ReactNode;
}

const ICON_CLASS_NAME = "size-5 text-muted-foreground";

/** Fades a single empty-state row so it stays readable but not fully solid. */
export const emptyRowFadeMaskStyle = {
    maskImage:
        "linear-gradient(to bottom, rgb(0 0 0 / 0.55) 0%, rgb(0 0 0 / 0.2) 100%)",
    WebkitMaskImage:
        "linear-gradient(to bottom, rgb(0 0 0 / 0.55) 0%, rgb(0 0 0 / 0.2) 100%)",
} as const;

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
    skeleton,
}: EmptyStateProps) {
    const renderIcon = () => {
        if (isValidElement(icon)) return icon;
        if (isHugeicon(icon))
            return <Icon icon={icon} className={ICON_CLASS_NAME} />;
        return icon;
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
