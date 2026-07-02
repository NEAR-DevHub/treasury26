import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import {
    type CreateProposalTemplateInput,
    createProposalTemplate,
    deleteProposalTemplate,
    type UpdateProposalTemplateInput,
    updateProposalTemplate,
} from "../api";

/**
 * Invalidate the template list after a mutation, using the exact queryKey `useProposalTemplates`
 * reads with (`["proposal-templates", treasuryId, accountId]`) so the invalidation is targeted
 * rather than a prefix sweep of every account's cache for the treasury.
 */
function useInvalidateTemplates() {
    const queryClient = useQueryClient();
    const { treasuryId } = useTreasury();
    const { accountId } = useNear();
    return () =>
        queryClient.invalidateQueries({
            queryKey: ["proposal-templates", treasuryId, accountId],
        });
}

/** Create a proposal template for the current treasury, invalidating the list on success. */
export function useCreateProposalTemplate() {
    const { treasuryId } = useTreasury();
    const invalidate = useInvalidateTemplates();

    return useMutation({
        mutationFn: (input: CreateProposalTemplateInput) =>
            createProposalTemplate(treasuryId as string, input),
        onSuccess: invalidate,
    });
}

/** Update a template by id, invalidating the list on success. */
export function useUpdateProposalTemplate() {
    const { treasuryId } = useTreasury();
    const invalidate = useInvalidateTemplates();

    return useMutation({
        mutationFn: ({
            id,
            input,
        }: {
            id: string;
            input: UpdateProposalTemplateInput;
        }) => updateProposalTemplate(treasuryId as string, id, input),
        onSuccess: invalidate,
    });
}

/** Delete a template by id, invalidating the list on success. */
export function useDeleteProposalTemplate() {
    const { treasuryId } = useTreasury();
    const invalidate = useInvalidateTemplates();

    return useMutation({
        mutationFn: (id: string) =>
            deleteProposalTemplate(treasuryId as string, id),
        onSuccess: invalidate,
    });
}
