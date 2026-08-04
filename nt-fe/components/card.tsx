import { cn } from "@/lib/utils";

export function PageCard({
    children,
    className,
    ...props
}: React.ComponentProps<"div">) {
    return (
        <div
            className={cn(
                "flex flex-col gap-4 rounded-2xl border border-gray-200 bg-card p-4 dark:border-general-border",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}
