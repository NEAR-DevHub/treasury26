import { useTranslations } from "next-intl";
import type { ProposalData, Treasury } from "../utils/types";
import { PrimaryButton } from "./primary-button";
import { ProposalPreview } from "./proposal-preview";

export function ConfirmTransactionsStep({
    accountId,
    selectedDao,
    treasuries,
    previewProposals,
    proposalDescription,
    onDescriptionChange,
    onConfirm,
}: {
    accountId: string | null;
    selectedDao: string | null;
    treasuries: Treasury[];
    previewProposals: ProposalData[];
    proposalDescription: string;
    onDescriptionChange: (value: string) => void;
    onConfirm: () => void;
}) {
    const tW = useTranslations("wallet");
    const treasuryName = treasuries.find((t) => t.daoId === selectedDao)?.config
        .name;

    return (
        <div className="flex flex-col flex-1">
            <div className="space-y-4 pb-4">
                <div className="p-4 bg-muted/50 rounded-lg">
                    <p className="text-xs uppercase tracking-wider text-muted-foreground">
                        {tW("actingAs", { count: previewProposals.length })}
                    </p>
                    <p className="text-sm font-semibold mt-2">
                        {treasuryName || selectedDao}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground mt-0.5">
                        {selectedDao}
                    </p>
                    <div className="border-t border-border mt-3 pt-3">
                        <p className="text-xs text-muted-foreground">
                            {tW("signedBy", { account: accountId ?? "" })}
                        </p>
                    </div>
                </div>

                <p className="text-xs text-muted-foreground">
                    {tW("createsNProposals", {
                        count: previewProposals.length,
                    })}
                </p>

                {previewProposals.map((proposal, i) => (
                    <div key={i} className="bg-muted/50 rounded-lg p-4">
                        <ProposalPreview proposalData={proposal} index={i} />
                    </div>
                ))}

                <input
                    type="text"
                    value={proposalDescription}
                    onChange={(e) => onDescriptionChange(e.target.value)}
                    placeholder={tW("proposalDescriptionPlaceholder")}
                    className="w-full px-4 py-3 bg-muted/50 rounded-lg text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                />

                {previewProposals.length > 0 && (
                    <p className="text-sm text-green-600 dark:text-green-400 bg-green-100 dark:bg-green-900/20 rounded-lg p-3">
                        {tW("walletOpensNotice", {
                            count: previewProposals.length,
                        })}
                    </p>
                )}
            </div>

            <PrimaryButton onClick={onConfirm}>
                {tW("createProposal", { count: previewProposals.length })}
            </PrimaryButton>
        </div>
    );
}

export function ProcessingStep({ count }: { count: number }) {
    const tW = useTranslations("wallet");

    return (
        <div className="text-center py-8">
            <div className="animate-spin w-8 h-8 border-2 border-primary border-t-transparent rounded-full mx-auto mb-4" />
            <p className="text-muted-foreground">
                {tW("creatingProposal", { count })}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
                {tW("confirmInWallet")}
            </p>
        </div>
    );
}
