import { Skeleton } from "@/components/ui/skeleton";

/** Matches the bulk upload / form step (token, tabs, drop zone, continue). */
export function BulkPaymentFormSkeleton() {
    return (
        <div
            className="flex w-full min-w-0 flex-col items-start justify-center gap-5 lg:flex-row"
            aria-busy="true"
        >
            <div className="mx-auto flex w-full min-w-0 max-w-lg flex-col gap-2 lg:mx-0">
                <Skeleton className="h-18 w-full rounded-3xl" />
                <Skeleton className="h-12 w-full rounded-2xl" />
                <Skeleton className="h-44 w-full rounded-3xl" />
                <Skeleton className="h-7 w-72 rounded-lg" />
                <Skeleton className="h-18 w-full rounded-3xl" />
                <Skeleton className="h-11 w-full rounded-2xl" />
            </div>
            <Skeleton className="h-30 w-full shrink-0 rounded-3xl lg:max-w-72" />
        </div>
    );
}
