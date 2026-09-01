import { cn } from "@/lib/utils";

/** Dashed empty-state icon used by Token / Network / Recipient selectors. */
export function EmptySelectorIcon({ className }: { className?: string }) {
    return (
        <span
            aria-hidden="true"
            className={cn(
                "flex size-10 shrink-0 items-center justify-center rounded-full border border-general-border bg-muted",
                className,
            )}
        >
            <svg
                viewBox="0 0 16 16"
                className="size-5 text-muted-foreground"
                fill="none"
                aria-hidden="true"
            >
                <circle
                    cx="8"
                    cy="8"
                    r="5.25"
                    stroke="currentColor"
                    strokeWidth="1.25"
                    strokeDasharray="2 2.5"
                    strokeLinecap="round"
                />
            </svg>
        </span>
    );
}

/**
 * Shared card-selector trigger styles (deposit / send / bulk).
 */
export const selectorTriggerClassName =
    "flex h-18 w-full cursor-pointer items-center gap-3 self-stretch rounded-3xl border border-general-border bg-card px-4 py-2.5 text-left hover:opacity-80";

/** Scrollable list inside payment select modals. Fills the sheet on mobile. */
export const paymentSelectModalListClassName =
    "min-h-0 flex-1 sm:h-140 sm:max-h-[90vh]";

/** Search field in token / network select modals. */
export const paymentSelectModalSearchInputClassName =
    "rounded-xl border border-general-border bg-card! hover:bg-card! focus-visible:border-general-border focus-visible:ring-0";
