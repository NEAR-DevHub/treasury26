import { useEffect, useState, useSyncExternalStore } from "react";
import {
    type BulkPaymentPrepareRequest,
    prepareConfidentialBulkPayment,
} from "@/lib/api";
import {
    createPrepareController,
    type PrepareState,
} from "./confidential-prepare";

/**
 * Fire the confidential prepare call for the given payment payload and
 * expose its lifecycle. Pass null while prepare shouldn't run (standard
 * flow, not on the review step); passing a payload starts the call, and a
 * changed payload (edit-and-return) re-fires it. The success state holds
 * the prepared response the confirm button submits from.
 */
export function useConfidentialPrepare(
    request: BulkPaymentPrepareRequest | null,
): { prepare: PrepareState; retryPrepare: () => void } {
    const [controller] = useState(() =>
        createPrepareController(prepareConfidentialBulkPayment),
    );
    // No dep array: `request` is rebuilt every render, so the controller
    // dedupes by content instead. Re-running with an unchanged payload is
    // a no-op.
    useEffect(() => {
        controller.setRequest(request);
    });
    const prepare = useSyncExternalStore(
        controller.subscribe,
        controller.getState,
        controller.getState,
    );
    return { prepare, retryPrepare: controller.retry };
}
