import { cn } from "@/lib/utils";
import { Separator } from "./ui/separator";
import { Tooltip as TooltipPrimitive, TooltipContent as TooltipContentPrimitive, TooltipTrigger } from "./ui/tooltip";

export interface TooltipProps {
    disabled?: boolean;
    children: React.ReactNode;
    content: React.ReactNode;
    contentProps?: Omit<React.ComponentProps<typeof TooltipContent>, 'children'>;
    triggerProps?: Omit<React.ComponentProps<typeof TooltipTrigger>, 'children'>;
}



export function TooltipContent({ children, className, ...props }: React.ComponentProps<typeof TooltipContentPrimitive>) {
    return (
        <TooltipContentPrimitive className="max-w-sm bg-card text-foreground border-border border text-sm" {...props}>
            {children}
        </TooltipContentPrimitive>
    );
}

export function Tooltip({ children, content, contentProps, triggerProps, disabled }: TooltipProps) {
    const { className, ...contentPropsRest } = contentProps || {};
    if (disabled) {
        return children;
    }
    return (
        <TooltipPrimitive disableHoverableContent={disabled}>
            <TooltipTrigger asChild {...triggerProps}>
                {children}
            </TooltipTrigger>
            <TooltipContent  {...contentPropsRest} className={cn("shadow-md", className)}>
                {content}
            </TooltipContent>
        </TooltipPrimitive>
    );
}
