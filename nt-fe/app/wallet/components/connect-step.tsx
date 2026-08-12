import { useTranslations } from "next-intl";
import { PrimaryButton } from "./primary-button";

export function ConnectStep({
    isAuthenticating,
    authError,
    onConnect,
}: {
    isAuthenticating: boolean;
    authError: string | null;
    onConnect: () => void;
}) {
    const tW = useTranslations("wallet");

    return (
        <div className="flex flex-col flex-1">
            <div className="flex-1 flex flex-col justify-center space-y-4">
                <p className="text-sm text-muted-foreground text-center whitespace-pre-line">
                    {tW("connectPrompt")}
                </p>
                {authError && (
                    <p className="text-sm text-red-600 dark:text-red-400 text-center">
                        {authError}
                    </p>
                )}
            </div>
            <PrimaryButton onClick={onConnect} disabled={isAuthenticating}>
                {isAuthenticating ? tW("connecting") : tW("connectWallet")}
            </PrimaryButton>
        </div>
    );
}

export function LoadingTreasuriesStep({ accountId }: { accountId: string }) {
    const tW = useTranslations("wallet");

    return (
        <div className="text-center space-y-6">
            <p className="text-sm text-muted-foreground">
                {tW.rich("connectedAs", {
                    account: accountId,
                    strong: (chunks) => (
                        <span className="block mt-1 font-mono text-base font-semibold text-foreground">
                            {chunks}
                        </span>
                    ),
                })}
            </p>
            <div className="animate-spin w-8 h-8 border-2 border-muted-foreground border-t-transparent rounded-full mx-auto" />
            <p className="text-sm text-muted-foreground">
                {tW("loadingTreasuries")}
            </p>
        </div>
    );
}
