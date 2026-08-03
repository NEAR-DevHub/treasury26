"use client";

import { cn } from "@/lib/utils";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import {
    Tooltip as TooltipPrimitive,
    TooltipContent as TooltipContentPrimitive,
    TooltipTrigger,
} from "./ui/tooltip";

export interface TooltipProps {
    disabled?: boolean;
    side?: "top" | "bottom" | "left" | "right";
    children: React.ReactNode;
    content: React.ReactNode;
    contentProps?: Omit<
        React.ComponentProps<typeof TooltipContent>,
        "children"
    >;
    triggerProps?: Omit<
        React.ComponentProps<typeof TooltipTrigger>,
        "children"
    >;
}

/**
 * Tooltips are dark in both themes. They're portalled to the body, so `dark` is
 * forced here for nested content to resolve its `dark:` variants against the
 * tooltip; the surface's own colours are written out, since the `dark` variant
 * only matches descendants.
 */
const tooltipSurfaceClass =
    "dark border border-white/10 bg-gray-950 text-white shadow-md";

function TooltipContent({
    children,
    className,
    ...props
}: React.ComponentProps<typeof TooltipContentPrimitive>) {
    return (
        <TooltipContentPrimitive
            className={cn("max-w-56 text-xs", tooltipSurfaceClass)}
            {...props}
        >
            {children}
        </TooltipContentPrimitive>
    );
}

function Tooltip({
    children,
    content,
    contentProps,
    triggerProps,
    disabled,
    side,
}: TooltipProps) {
    const { className, ...contentPropsRest } = contentProps || {};
    const isTouchDevice = useMediaQuery("(hover: none)");

    if (disabled) {
        return children;
    }

    if (isTouchDevice) {
        return (
            <Popover>
                <PopoverTrigger asChild>{children}</PopoverTrigger>
                <PopoverContent
                    side={side}
                    className={cn(
                        "w-auto max-w-56 p-2 text-xs",
                        tooltipSurfaceClass,
                        className,
                    )}
                >
                    {content}
                </PopoverContent>
            </Popover>
        );
    }

    return (
        <TooltipPrimitive disableHoverableContent={disabled}>
            <TooltipTrigger type="button" asChild {...triggerProps}>
                {children}
            </TooltipTrigger>
            <TooltipContent
                side={side}
                {...contentPropsRest}
                className={cn("shadow-md", className)}
            >
                {content}
            </TooltipContent>
        </TooltipPrimitive>
    );
}

export { Tooltip, TooltipContent, TooltipTrigger };
