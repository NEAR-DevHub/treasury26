import { cn } from "@/lib/utils";
import { Tooltip as TooltipPrimitive, TooltipContent as TooltipContentPrimitive, TooltipTrigger } from "./ui/tooltip";

export interface TooltipProps {
    disabled?: boolean;
    side?: "top" | "bottom" | "left" | "right";
    children: React.ReactNode;
    content: React.ReactNode;
    contentProps?: Omit<React.ComponentProps<typeof TooltipContent>, 'children'>;
    triggerProps?: Omit<React.ComponentProps<typeof TooltipTrigger>, 'children'>;
}



function TooltipContent({ children, className, ...props }: React.ComponentProps<typeof TooltipContentPrimitive>) {
    return (
        <TooltipContentPrimitive className="max-w-56 shadow-md bg-card text-foreground border-border border text-xs" {...props}>
            {children}
        </TooltipContentPrimitive>
    );
}

function Tooltip({ children, content, contentProps, triggerProps, disabled, side }: TooltipProps) {
    const { className, ...contentPropsRest } = contentProps || {};
    if (disabled) {
        return children;
    }
    return (
        <TooltipPrimitive disableHoverableContent={disabled}>
            <TooltipTrigger type="button" asChild {...triggerProps}>
                {children}
            </TooltipTrigger>
            <TooltipContent side={side} {...contentPropsRest} className={cn("shadow-md", className)}>
                {content}
            </TooltipContent>
        </TooltipPrimitive>
    );
}

export { Tooltip, TooltipContent, TooltipTrigger };
