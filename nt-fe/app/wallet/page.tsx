"use client";

import { Suspense } from "react";
import { AuthProvider } from "@/components/auth-provider";
import { LoadingScreen } from "@/components/loading-screen";
import {
    ConfirmTransactionsStep,
    ProcessingStep,
} from "./components/confirm-transactions-step";
import { ConnectStep, LoadingTreasuriesStep } from "./components/connect-step";
import { DoneStep } from "./components/done-step";
import { ErrorStep } from "./components/error-step";
import { SelectTreasuryStep } from "./components/select-treasury-step";
import { WaitingApprovalStep } from "./components/waiting-approval-step";
import { WalletLogo } from "./components/wallet-logo";
import { useWalletFlow } from "./hooks/use-wallet-flow";

export default function WalletPage() {
    return (
        <Suspense fallback={<LoadingScreen />}>
            <AuthProvider>
                <WalletPageContent />
            </AuthProvider>
        </Suspense>
    );
}

function WalletPageContent() {
    const flow = useWalletFlow();

    return (
        // Full-bleed in the popup window; from `sm` up (a regular tab) the
        // same content sits in a centered card, like the pre-redesign layout.
        <div className="min-h-screen flex flex-col items-center sm:justify-center bg-background text-foreground py-8 px-7">
            <div className="w-full max-w-md flex flex-col flex-1 sm:flex-initial sm:min-h-[600px] sm:bg-card sm:border sm:border-border sm:rounded-xl sm:shadow-lg sm:py-8 sm:px-7">
                {/* Header */}
                <div className="pb-4 flex justify-center">
                    <WalletLogo className="h-11 w-auto" />
                </div>

                {/* Content */}
                <div className="flex-1 flex flex-col justify-center">
                    {flow.step === "connect" && !flow.accountId && (
                        <ConnectStep
                            isAuthenticating={flow.isAuthenticating}
                            authError={flow.authError}
                            onConnect={flow.handleConnect}
                        />
                    )}

                    {flow.step === "connect" && flow.accountId && (
                        <LoadingTreasuriesStep accountId={flow.accountId} />
                    )}

                    {flow.step === "select-treasury" && (
                        <SelectTreasuryStep
                            accountId={flow.accountId}
                            action={flow.action}
                            dappHost={flow.dappHost}
                            treasuries={flow.treasuries}
                            treasuriesLoading={flow.treasuriesLoading}
                            onSelect={flow.handleSelectTreasury}
                        />
                    )}

                    {flow.step === "confirm-transactions" && (
                        <ConfirmTransactionsStep
                            accountId={flow.accountId}
                            selectedDao={flow.selectedDao}
                            treasuries={flow.treasuries}
                            previewProposals={flow.previewProposals}
                            proposalDescription={flow.proposalDescription}
                            onDescriptionChange={flow.setProposalDescription}
                            onConfirm={flow.handleConfirmTransactions}
                        />
                    )}

                    {flow.step === "processing" && (
                        <ProcessingStep count={flow.previewProposals.length} />
                    )}

                    {flow.step === "waiting-approval" && (
                        <WaitingApprovalStep
                            selectedDao={flow.selectedDao}
                            proposalIds={flow.proposalIds}
                            note={flow.note}
                        />
                    )}

                    {flow.step === "done" && <DoneStep action={flow.action} />}

                    {flow.step === "error" && (
                        <ErrorStep
                            action={flow.action}
                            error={flow.error}
                            attemptedCount={Math.max(
                                flow.previewProposals.length,
                                1,
                            )}
                            proposalsCreated={flow.proposalIds.length > 0}
                            canRetryCreate={flow.transactions.length > 0}
                            onRetry={flow.retry}
                        />
                    )}
                </div>
            </div>
        </div>
    );
}
