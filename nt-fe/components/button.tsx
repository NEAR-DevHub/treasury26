import { cn } from "@/lib/utils";
import { Button as ShadcnButton, buttonVariants } from "./ui/button";
import { VariantProps } from "class-variance-authority";
import { Tooltip } from "./tooltip";
import { Loader2 } from "lucide-react";

interface ButtonProps extends React.ComponentProps<typeof ShadcnButton> {
  variant?: VariantProps<typeof buttonVariants>["variant"];
  size?: VariantProps<typeof buttonVariants>["size"];
}

interface ButtonPropsWithTooltip extends ButtonProps {
  tooltipContent?: React.ReactNode;
  loading?: boolean;
}

export function Button({
  variant,
  className: classNameOverride,
  size,
  tooltipContent,
  loading,
  children,
  disabled,
  ...props
}: ButtonPropsWithTooltip) {
  let className = "";
  switch (variant ?? "default") {
    case "link":
      className =
        "hover:no-underline font-semibold text-primary/80 hover:text-primary";
      break;
    case "ghost":
    case "outline":
      className = "hover:bg-muted-foreground/5";
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
      sizeClassName = "py-[5.5px] px-5 gap-1.5 rounded-[8px]";
  }

  const isDisabled = disabled || loading;

  const button = (
    <ShadcnButton
      variant={variant}
      className={cn(className, sizeClassName, classNameOverride)}
      size={size}
      disabled={isDisabled}
      {...props}
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </ShadcnButton>
  );

  if (tooltipContent) {
    return (
      <Tooltip content={tooltipContent} triggerProps={{ asChild: !isDisabled }}>
        {button}
      </Tooltip>
    );
  }

  return button;
}
