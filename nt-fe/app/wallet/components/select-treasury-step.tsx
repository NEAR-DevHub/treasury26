import { useTranslations } from "next-intl";
import type { Treasury, WalletAction } from "../utils/types";

export function SelectTreasuryStep({
    accountId,
    action,
    dappHost,
    treasuries,
    treasuriesLoading,
    onSelect,
}: {
    accountId: string | null;
    action: WalletAction;
    dappHost: string | null;
    treasuries: Treasury[];
    treasuriesLoading: boolean;
    onSelect: (daoId: string) => void;
}) {
    const tW = useTranslations("wallet");

    return (
        <div className="space-y-4">
            <div className="flex items-center justify-between">
                <p className="text-sm text-muted-foreground">
                    {tW.rich("connectedAs", {
                        account: accountId ?? "",
                        strong: (chunks) => (
                            <span className="font-mono font-medium text-foreground">
                                {chunks}
                            </span>
                        ),
                    })}
                </p>
            </div>
            <p className="text-sm font-medium">
                {action === "sign_in"
                    ? tW("selectSignIn", { app: dappHost ?? "unknown" })
                    : tW("selectSignTx")}
            </p>
            {treasuries.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-4">
                    {treasuriesLoading
                        ? tW("loadingTreasuries")
                        : tW("notMember")}
                </p>
            ) : (
                <div className="space-y-2 max-h-80 overflow-y-auto">
                    {treasuries.map((t) => (
                        <button
                            key={t.daoId}
                            type="button"
                            onClick={() => onSelect(t.daoId)}
                            className="w-full p-3 text-left bg-muted/50 rounded-lg cursor-pointer hover:bg-muted active:bg-muted/80 transition-colors"
                        >
                            <div className="text-sm font-medium">
                                {t.config.name || t.daoId}
                            </div>
                            <div className="font-mono text-xs text-muted-foreground mt-1">
                                {t.daoId}
                            </div>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
