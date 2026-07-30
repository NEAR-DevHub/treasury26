import { cn } from "@/lib/utils";
import { Button as ShadcnButton, buttonVariants } from "./ui/button";
import { VariantProps } from "class-variance-authority";
import { Tooltip } from "./tooltip";

type ShadcnVariant = VariantProps<typeof buttonVariants>["variant"];

interface ButtonProps
    extends Omit<React.ComponentProps<typeof ShadcnButton>, "variant"> {
    variant?: ShadcnVariant | "outline-destructive" | "card";
    size?: VariantProps<typeof buttonVariants>["size"];
}

interface ButtonPropsWithTooltip extends ButtonProps {
    tooltipContent?: React.ReactNode;
    side?: "top" | "bottom" | "left" | "right";
}

export function Button({
    variant,
    className: classNameOverride,
    size,
    tooltipContent,
    side,
    ...props
}: ButtonPropsWithTooltip) {
    const { disabled } = props;
    let className = "";
    switch (variant ?? "default") {
        case "link":
            className =
                "hover:no-underline font-semibold text-foreground/80 hover:text-foreground";
            break;
        case "card":
            className = "bg-card text-foreground hover:bg-card/80";
            break;
        case "ghost":
            className = "hover:bg-muted-foreground/5";
            break;
        case "outline":
            className = "hover:bg-muted-foreground/5 border";
            break;
        case "outline-destructive":
            className =
                "border text-destructive hover:text-destructive hover:bg-destructive/10";
            break;
    }

    // Geometry (height/padding/radius) is owned by `ui/button`'s cva. This
    // wrapper only layers variant colors on top — emitting geometry here would
    // win the `twMerge` and defeat the design system's sizes at every call site.
    const shadcnVariant: ShadcnVariant =
        variant === "outline-destructive"
            ? "outline"
            : variant === "card"
              ? "secondary"
              : variant;

    const button = (
        <ShadcnButton
            variant={shadcnVariant}
            className={cn(className, classNameOverride)}
            size={size}
            {...props}
        />
    );

    if (tooltipContent) {
        // When disabled, wrap in a span to avoid nested <button> elements (TooltipTrigger renders a button when asChild=false)
        const triggerChild = disabled ? (
            <span className={cn("inline-flex", classNameOverride)}>
                {button}
            </span>
        ) : (
            button
        );
        return (
            <Tooltip
                content={tooltipContent}
                triggerProps={{ asChild: true }}
                side={side}
            >
                {triggerChild}
            </Tooltip>
        );
    }

    return button;
}
