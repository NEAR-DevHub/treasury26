import { useTranslations } from "next-intl";
import { PrimaryButton } from "./primary-button";

export function WaitingApprovalStep({
    selectedDao,
    proposalIds,
    note,
}: {
    selectedDao: string | null;
    proposalIds: number[];
    note: string | null;
}) {
    const tW = useTranslations("wallet");

    return (
        <div className="flex flex-col flex-1">
            <div className="space-y-4 pb-4">
                <div className="w-12 h-12 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mx-auto">
                    <svg
                        className="w-6 h-6 text-green-600 dark:text-green-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                    >
                        <path
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            strokeWidth={2}
                            d="M5 13l4 4L19 7"
                        />
                    </svg>
                </div>
                <p className="text-center font-medium text-lg">
                    {tW("proposalSubmitted", { count: proposalIds.length })}
                </p>
                <p className="text-sm text-muted-foreground text-center">
                    {tW("shareProposal", { count: proposalIds.length })}
                </p>

                <p className="text-xs uppercase tracking-wider text-muted-foreground pt-2">
                    {tW("whatToDoNext")}
                </p>

                <div className="space-y-2">
                    <div className="flex gap-3 p-3 rounded-lg bg-blue-100 dark:bg-blue-900/20">
                        <span className="w-6 h-6 shrink-0 rounded-full bg-blue-600 text-white text-xs font-medium flex items-center justify-center">
                            1
                        </span>
                        <div className="min-w-0">
                            <p className="text-sm font-medium">
                                {tW("stepApproveTitle", {
                                    count: proposalIds.length,
                                })}
                            </p>
                            <div className="mt-1 space-y-1">
                                {proposalIds.map((id) => (
                                    <a
                                        key={id}
                                        href={`/${selectedDao}/requests/${id}`}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="block font-mono text-xs text-blue-600 dark:text-blue-400 hover:text-blue-500 dark:hover:text-blue-300 underline truncate transition-colors"
                                    >
                                        {tW("proposalLink", {
                                            daoId: selectedDao ?? "",
                                            id,
                                        })}
                                    </a>
                                ))}
                            </div>
                        </div>
                    </div>

                    <div className="flex gap-3 p-3 rounded-lg bg-muted/50">
                        <span className="w-6 h-6 shrink-0 rounded-full bg-muted text-muted-foreground text-xs font-medium flex items-center justify-center">
                            2
                        </span>
                        <div>
                            <p className="text-sm font-medium">
                                {tW("stepVotesTitle")}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5">
                                {tW("stepVotesDesc")}
                            </p>
                        </div>
                    </div>

                    <div className="flex gap-3 p-3 rounded-lg bg-muted/50">
                        <span className="w-6 h-6 shrink-0 rounded-full bg-muted text-muted-foreground text-xs font-medium flex items-center justify-center">
                            3
                        </span>
                        <p className="text-sm font-medium self-center">
                            {tW("stepExecutedTitle")}
                        </p>
                    </div>
                </div>

                {note && (
                    <p className="text-sm text-amber-600 dark:text-amber-400 text-center">
                        {note}
                    </p>
                )}
            </div>

            <PrimaryButton
                onClick={() =>
                    window.open(
                        `/${selectedDao}/requests?tab=InProgress`,
                        "_blank",
                        "noopener",
                    )
                }
            >
                {tW("openTrezuApprove")}
            </PrimaryButton>
        </div>
    );
}
