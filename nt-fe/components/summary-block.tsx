import { cn } from "@/lib/utils";

interface SummaryBlockProps {
    title?: string;
    icon?: React.ReactNode;
    secondRow?: React.ReactNode;
    subRow?: React.ReactNode;
    children?: React.ReactNode;
    className?: string;
    /**
     * When true, wraps content in a bordered summary card
     * When false, renders a compact standalone card
     * Default: true
     */
    useInputBlock?: boolean;
}

export function SummaryBlock({
    title,
    icon,
    secondRow,
    subRow,
    children,
    className,
    useInputBlock = true,
}: SummaryBlockProps) {
    if (!useInputBlock) {
        return (
            <div className="flex h-44 w-full max-w-72 items-center justify-center rounded-lg border bg-muted">
                <div
                    className={cn(
                        "flex flex-col items-center justify-center gap-2.5 text-center text-muted-foreground",
                        className,
                    )}
                >
                    {title && <p className="text-xs font-medium">{title}</p>}
                    {icon}
                    {secondRow && (
                        <div className="flex w-full min-w-0 max-w-full flex-col gap-0.5">
                            {secondRow}
                            {subRow}
                        </div>
                    )}
                    {children && <div>{children}</div>}
                </div>
            </div>
        );
    }

    return (
        <div
            className={cn(
                "mx-auto flex h-44 w-full max-w-lg flex-col items-center justify-center gap-2.5 self-center rounded-3xl border border-general-border bg-card px-4 text-center text-muted-foreground",
                className,
            )}
        >
            {title && <p className="text-xs font-medium">{title}</p>}
            {icon}
            {secondRow}
            {subRow}
            {children}
        </div>
    );
}
