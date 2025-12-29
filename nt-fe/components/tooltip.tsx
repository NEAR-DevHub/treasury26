import { cn } from "@/lib/utils";
import { Separator } from "./ui/separator";
import { Tooltip as TooltipPrimitive, TooltipContent as TooltipContentPrimitive, TooltipTrigger } from "./ui/tooltip";

export interface TooltipProps {
    children: React.ReactNode;
    content: React.ReactNode;
    contentProps?: Omit<React.ComponentProps<typeof TooltipContent>, 'children'>;
    triggerProps?: Omit<React.ComponentProps<typeof TooltipTrigger>, 'children'>;
}



export function TooltipContent({ children, className, ...props }: React.ComponentProps<typeof TooltipContentPrimitive>) {
    return (
        <TooltipContentPrimitive className={cn("max-w-80 bg-card text-primary border-border border text-sm", className)} {...props}>
            {children}
        </TooltipContentPrimitive>
    );
}

export function Tooltip({ children, content, contentProps, triggerProps }: TooltipProps) {
    const { className, ...contentPropsRest } = contentProps || {};
    return (
        <TooltipPrimitive>
            <TooltipTrigger asChild {...triggerProps}>
                {children}
            </TooltipTrigger>
            <TooltipContent  {...contentPropsRest} className={cn("shadow-md", className)}>
                {content}
            </TooltipContent>
        </TooltipPrimitive>
    );
}
