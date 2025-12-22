import { Tooltip as TooltipPrimitive, TooltipContent as TooltipContentPrimitive, TooltipTrigger } from "./ui/tooltip";

export interface TooltipProps {
    children: React.ReactNode;
    content: React.ReactNode;
    contentProps?: Omit<React.ComponentProps<typeof TooltipContent>, 'children'>;
    triggerProps?: Omit<React.ComponentProps<typeof TooltipTrigger>, 'children'>;
}

export function TooltipContent({ children, ...props }: React.ComponentProps<typeof TooltipContentPrimitive>) {
    return (
        <TooltipContentPrimitive className="max-w-80 bg-card text-primary border-border border text-sm" {...props}>
            {children}
        </TooltipContentPrimitive>
    );
}

export function Tooltip({ children, content, contentProps, triggerProps }: TooltipProps) {
    return (
        <TooltipPrimitive>
            <TooltipTrigger asChild {...triggerProps}>
                {children}
            </TooltipTrigger>
            <TooltipContent  {...contentProps}>
                {content}
            </TooltipContent>
        </TooltipPrimitive>
    );
}
