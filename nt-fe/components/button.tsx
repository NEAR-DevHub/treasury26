import { cn } from "@/lib/utils";
import { Button as ShadcnButton, buttonVariants } from "./ui/button";
import { VariantProps } from "class-variance-authority";
import { Tooltip } from "./tooltip";

interface ButtonProps extends React.ComponentProps<typeof ShadcnButton> {
    variant?: VariantProps<typeof buttonVariants>["variant"];
    size?: VariantProps<typeof buttonVariants>["size"];
}

interface ButtonPropsWithTooltip extends ButtonProps {
    tooltipContent?: React.ReactNode;
    side?: "top" | "bottom" | "left" | "right";
}

export function Button({ variant, className: classNameOverride, size, tooltipContent, side, ...props }: ButtonPropsWithTooltip) {
    const { disabled } = props;
    let className = "";
    switch (variant ?? "default") {
        case "link":
            className = "hover:no-underline font-semibold text-foreground/80 hover:text-foreground";
            break;
        case "ghost":
            className = "hover:bg-muted-foreground/5";
            break;
        case "outline":
            className = "hover:bg-muted-foreground/5 border";
            break;
    }

    let sizeClassName = "";
    switch (size) {
        case "sm":
            sizeClassName = "py-0.5 px-2.5 h-5 text-xs";
            break;
        case "lg":
            sizeClassName = "h-13 font-semibold text-lg";
        default:
            sizeClassName = "py-[5.5px]! px-5! gap-1.5 rounded-[8px]";
    }
    const button = <ShadcnButton variant={variant} className={cn(className, sizeClassName, classNameOverride)} size={size} {...props} />;

    if (tooltipContent) {
        // When disabled, wrap in a span to avoid nested <button> elements (TooltipTrigger renders a button when asChild=false)
        const triggerChild = disabled ? <span className={cn("inline-flex", classNameOverride)}>{button}</span> : button;
        return <Tooltip content={tooltipContent} triggerProps={{ asChild: true }} side={side}>{triggerChild}</Tooltip>;
    }

    return button;
};
