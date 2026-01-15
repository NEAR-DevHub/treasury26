import { useQuery } from "@tanstack/react-query";
import {
  getBulkPaymentListStatus,
  getBulkPaymentTransactions,
  getBulkPaymentTransactionHash,
} from "@/lib/api";

/**
 * Query hook to get bulk payment list status
 * Returns status including counts of processed/pending payments
 */
export function useBulkPaymentListStatus(listId: string | null | undefined) {
  return useQuery({
    queryKey: ["bulkPaymentListStatus", listId],
    queryFn: () => getBulkPaymentListStatus(listId!),
    enabled: !!listId,
    staleTime: 1000 * 30, // 30 seconds (status can change as payments process)
  });
}

/**
 * Query hook to get all payment transactions for a bulk payment list
 * Returns the list of completed payment transactions with block heights
 */
export function useBulkPaymentTransactions(listId: string | null | undefined) {
  return useQuery({
    queryKey: ["bulkPaymentTransactions", listId],
    queryFn: () => getBulkPaymentTransactions(listId!),
    enabled: !!listId,
    staleTime: 1000 * 60, // 1 minute (transaction data doesn't change once complete)
  });
}

/**
 * Query hook to get the transaction hash for a specific payment recipient
 * Returns the blockchain transaction hash for a completed payment
 */
export function useBulkPaymentTransactionHash(
  listId: string | null | undefined,
  recipient: string | null | undefined
) {
  return useQuery({
    queryKey: ["bulkPaymentTransactionHash", listId, recipient],
    queryFn: () => getBulkPaymentTransactionHash(listId!, recipient!),
    enabled: !!listId && !!recipient,
    staleTime: 1000 * 60 * 60, // 1 hour (transaction hashes are immutable)
  });
}
