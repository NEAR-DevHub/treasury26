"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
    removeUserTreasury,
    saveUserTreasury,
    setUserTreasuryHidden,
} from "@/lib/api";

interface TreasuryNavItem {
    daoId: string;
}

interface TreasuryNavContext {
    pathname?: string | null;
    treasuries: TreasuryNavItem[];
    push: (href: string) => void;
}

interface MutationBehavior {
    navigateOnSuccess?: boolean;
}

function buildTreasuryHref(
    pathname: string | null | undefined,
    daoId: string,
): string {
    const pathAfterTreasury = pathname?.split("/").slice(2).join("/") || "";
    return `/${daoId}/${pathAfterTreasury}`;
}

export function useSaveTreasuryMutation(
    accountId: string | null | undefined,
    treasuryId: string | undefined,
) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async () => {
            if (!accountId || !treasuryId) {
                throw new Error("Missing account or treasury");
            }
            await saveUserTreasury(accountId, treasuryId);
        },
        onSuccess: async () => {
            toast.success("Treasury saved to your list");
            await queryClient.invalidateQueries({
                queryKey: ["userTreasuries", accountId],
            });
        },
        onError: () => {
            toast.error("Failed to save treasury");
        },
    });
}

export function useHideTreasuryMutation(
    accountId: string | null | undefined,
    navContext: TreasuryNavContext,
    behavior: MutationBehavior = { navigateOnSuccess: true },
) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (daoId: string) => {
            if (!accountId) throw new Error("Missing account");
            await setUserTreasuryHidden(accountId, daoId, true);
        },
        onSuccess: async (_, hiddenDaoId) => {
            toast.success("Treasury hidden from list");
            await queryClient.invalidateQueries({
                queryKey: ["userTreasuries", accountId],
            });
            if (behavior.navigateOnSuccess !== false) {
                const nextTreasury = navContext.treasuries.find(
                    (treasury) => treasury.daoId !== hiddenDaoId,
                );
                if (nextTreasury) {
                    navContext.push(
                        buildTreasuryHref(
                            navContext.pathname,
                            nextTreasury.daoId,
                        ),
                    );
                } else {
                    navContext.push("/app");
                }
            }
        },
        onError: () => {
            toast.error("Failed to hide treasury");
        },
    });
}

export function useUnhideTreasuryMutation(
    accountId: string | null | undefined,
) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (daoId: string) => {
            if (!accountId) throw new Error("Missing account");
            await setUserTreasuryHidden(accountId, daoId, false);
        },
        onSuccess: async () => {
            toast.success("Treasury is visible again");
            await queryClient.invalidateQueries({
                queryKey: ["userTreasuries", accountId],
            });
        },
        onError: () => {
            toast.error("Failed to unhide treasury");
        },
    });
}

export function useRemoveSavedTreasuryMutation(
    accountId: string | null | undefined,
    navContext: TreasuryNavContext,
    behavior: MutationBehavior = { navigateOnSuccess: true },
) {
    const queryClient = useQueryClient();

    return useMutation({
        mutationFn: async (daoId: string) => {
            if (!accountId) throw new Error("Missing account");
            await removeUserTreasury(accountId, daoId);
        },
        onSuccess: async (_, removedDaoId) => {
            toast.success("Treasury removed from saved list");
            await queryClient.invalidateQueries({
                queryKey: ["userTreasuries", accountId],
            });
            if (behavior.navigateOnSuccess !== false) {
                const nextTreasury = navContext.treasuries.find(
                    (treasury) => treasury.daoId !== removedDaoId,
                );
                if (nextTreasury) {
                    navContext.push(
                        buildTreasuryHref(
                            navContext.pathname,
                            nextTreasury.daoId,
                        ),
                    );
                }
            }
        },
        onError: () => {
            toast.error("Failed to remove treasury from saved list");
        },
    });
}
