import { cn } from "@/lib/utils";

const radiusClasses = {
    "2xl": "rounded-2xl",
    "3xl": "rounded-3xl",
} as const;

export function PageCard({
    children,
    className,
    radius = "3xl",
    ...props
}: React.ComponentProps<"div"> & {
    radius?: keyof typeof radiusClasses;
}) {
    return (
        <div
            className={cn(
                "flex flex-col gap-4 border border-gray-200 bg-card p-4 dark:border-general-border",
                radiusClasses[radius],
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}
