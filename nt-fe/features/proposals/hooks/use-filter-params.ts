"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

/**
 * Filters live in the URL so they survive reloads and can be shared. Every
 * write resets pagination, since page 3 of the old result set is meaningless
 * once the set changes. A `null` value drops the parameter entirely.
 */
export function useFilterParams() {
    const searchParams = useSearchParams();
    const router = useRouter();
    const pathname = usePathname();

    const setFilters = useCallback(
        (updates: Record<string, string | null>) => {
            const params = new URLSearchParams(searchParams.toString());
            Object.entries(updates).forEach(([key, value]) => {
                if (value === null) {
                    params.delete(key);
                } else {
                    params.set(key, value);
                }
            });
            params.delete("page");
            router.push(`${pathname}?${params.toString()}`);
        },
        [searchParams, router, pathname],
    );

    return { searchParams, setFilters };
}
