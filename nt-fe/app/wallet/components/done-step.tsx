import { useTranslations } from "next-intl";
import type { WalletAction } from "../utils/types";

export function DoneStep({ action }: { action: WalletAction }) {
    const tW = useTranslations("wallet");

    return (
        <div className="text-center py-8 space-y-4">
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
            <p className="font-medium">
                {action === "sign_in"
                    ? tW("signedInSuccess")
                    : tW("proposalCreatedSuccess")}
            </p>
            {action !== "sign_in" && (
                <p className="text-sm text-muted-foreground">
                    {tW("closeWindow")}
                </p>
            )}
        </div>
    );
}
