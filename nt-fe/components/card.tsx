import { cn } from "@/lib/utils";

export function PageCard({
    children,
    className,
    flushOnMobile = false,
    ...props
}: React.ComponentProps<"div"> & { flushOnMobile?: boolean }) {
    return (
        <div
            className={cn(
                "flex flex-col gap-4 rounded-2xl border border-gray-200 bg-card p-4 dark:border-general-border",
                flushOnMobile &&
                    "max-lg:rounded-none max-lg:border-0 max-lg:bg-transparent max-lg:p-0",
                className,
            )}
            {...props}
        >
            {children}
        </div>
    );
}
