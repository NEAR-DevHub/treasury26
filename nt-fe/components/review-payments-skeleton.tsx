import { Skeleton } from "@/components/ui/skeleton";

const REVIEW_SKELETON_ROW_KEYS = [
    "one",
    "two",
    "three",
    "four",
    "five",
] as const;

export function ReviewPaymentsSkeleton({
    recipientCount,
}: {
    recipientCount: number;
}) {
    const rowCount = Math.min(Math.max(recipientCount, 1), 5);

    return (
        <>
            <Skeleton className="mx-auto h-44 w-full max-w-lg rounded-3xl" />
            <div className="mt-2 flex w-full flex-col gap-4">
                {REVIEW_SKELETON_ROW_KEYS.slice(0, rowCount).map((rowId) => (
                    <div
                        key={rowId}
                        className="flex flex-col gap-2 border-b border-general-border pb-4"
                    >
                        <div className="flex items-center justify-between gap-2">
                            <Skeleton className="h-5 w-24" />
                            <div className="flex items-center gap-3">
                                <Skeleton className="size-3.5" />
                                <Skeleton className="size-3.5" />
                            </div>
                        </div>
                        <div className="flex justify-between gap-2">
                            <Skeleton className="h-5 w-36" />
                            <div className="flex flex-col items-end gap-1">
                                <Skeleton className="h-5 w-28" />
                                <Skeleton className="h-4 w-16" />
                            </div>
                        </div>
                    </div>
                ))}
                <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-5 w-32" />
                    <Skeleton className="h-5 w-24" />
                </div>
                <div className="flex items-center justify-between gap-2">
                    <Skeleton className="h-5 w-24" />
                    <Skeleton className="h-5 w-20" />
                </div>
                <Skeleton className="h-11 w-full rounded-xl" />
            </div>
        </>
    );
}
