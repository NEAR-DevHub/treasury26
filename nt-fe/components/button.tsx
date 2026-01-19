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
}

export function Button({ variant, className: classNameOverride, size, tooltipContent, ...props }: ButtonPropsWithTooltip) {
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
        return <Tooltip content={tooltipContent} triggerProps={{ asChild: !disabled }}>{button}</Tooltip>;
    }

    return button;
};
