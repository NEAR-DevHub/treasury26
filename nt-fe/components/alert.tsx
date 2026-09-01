import { cn } from "@/lib/utils";
import {
    Alert as ShadcnAlert,
    AlertTitle as ShadcnAlertTitle,
    AlertDescription as ShadcnAlertDescription,
} from "./ui/alert";

interface AlertProps
    extends Omit<React.ComponentProps<typeof ShadcnAlert>, "variant"> {
    variant?: "default" | "info" | "destructive" | "warning";
}

export function Alert({
    variant,
    className: classNameOverride,
    ...props
}: AlertProps) {
    let className = "";

    // Add custom styling overrides per variant
    switch (variant) {
        case "info":
            className =
                "border border-general-info-border bg-general-info-background-faded text-general-info-foreground [&>svg]:text-general-info-foreground";
            break;
        case "warning":
            className =
                "border border-general-warning-border bg-general-warning-background-faded text-general-warning-foreground [&>svg]:text-general-warning-foreground";
            break;
        case "destructive":
            className =
                "bg-red-50 dark:bg-red-950/50 text-red-800 dark:text-red-200 [&>svg]:text-red-600 dark:[&>svg]:text-red-400";
            break;
    }

    return (
        <ShadcnAlert
            variant={
                variant === "warning" || variant === "info"
                    ? "default"
                    : variant
            }
            className={cn(
                "inline-flex text-wrap",
                variant === "default" || !variant ? "border-none" : null,
                className,
                classNameOverride,
            )}
            {...props}
        />
    );
}

export function AlertTitle({
    className: classNameOverride,
    ...props
}: React.ComponentProps<typeof ShadcnAlertTitle>) {
    return <ShadcnAlertTitle className={cn(classNameOverride)} {...props} />;
}

export function AlertDescription({
    className: classNameOverride,
    ...props
}: React.ComponentProps<typeof ShadcnAlertDescription>) {
    return (
        <ShadcnAlertDescription
            className={cn("text-current!", classNameOverride)}
            {...props}
        />
    );
}
