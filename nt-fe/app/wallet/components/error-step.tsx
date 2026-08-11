import { useTranslations } from "next-intl";
import type { WalletAction } from "../utils/types";
import { PrimaryButton } from "./primary-button";

export function ErrorStep({
    action,
    error,
    attemptedCount,
    proposalsCreated,
    canRetryCreate,
    onRetry,
}: {
    action: WalletAction;
    error: string | null;
    /** How many proposals the request would create (>= 1). */
    attemptedCount: number;
    /** True once proposals exist on-chain (failure happened after creation). */
    proposalsCreated: boolean;
    /** True when the original transactions payload is still available. */
    canRetryCreate: boolean;
    onRetry: () => void;
}) {
    const tW = useTranslations("wallet");

    return (
        <div className="flex flex-col flex-1">
            <div className="flex-1 flex flex-col justify-center text-center space-y-4">
                <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mx-auto">
                    <svg
                        className="w-6 h-6 text-red-600 dark:text-red-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M6 18L18 6M6 6l12 12"
                        />
                    </svg>
                </div>
                <p className="font-medium text-lg">
                    {action === "sign_transactions" && !proposalsCreated
                        ? tW("errorProposalsNotCreated", {
                              count: attemptedCount,
                          })
                        : tW("errorGeneric")}
                </p>
                {error && (
                    <p className="text-sm text-muted-foreground">{error}</p>
                )}
            </div>
            <PrimaryButton onClick={onRetry}>
                {canRetryCreate
                    ? tW("tryCreateAgain", { count: attemptedCount })
                    : tW("tryAgain")}
            </PrimaryButton>
        </div>
    );
}
