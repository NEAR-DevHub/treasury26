import { cn } from "@/lib/utils";
import { Button as ShadcnButton, buttonVariants } from "./ui/button";
import { VariantProps } from "class-variance-authority";

interface ButtonProps extends React.ComponentProps<typeof ShadcnButton> {
    variant?: VariantProps<typeof buttonVariants>["variant"];
    size?: VariantProps<typeof buttonVariants>["size"];
}

export function Button({ variant, className: classNameOverride, size, ...props }: ButtonProps) {
    let className = "";
    switch (variant) {
        case "link":
            className = "hover:no-underline font-semibold text-primary/80 hover:text-primary";
            break;
        default:
            className = "";
            break;
    }

    switch (size) {
        case "sm":
            className = cn(className, "py-0.5 px-2.5 h-5 text-xs");
            break;
        case "default":
            className = cn(className, "py-[5.5px] px-5 gap-1.5 rounded-[8px]");
        default:
            className = "";
            break;
    }


    return <ShadcnButton variant={variant} className={cn(className, classNameOverride)} size={size} {...props} />;
};
