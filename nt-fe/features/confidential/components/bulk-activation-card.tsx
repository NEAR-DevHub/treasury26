"use client";

import {
    AlertTriangle,
    CheckCircle2,
    Loader2,
    ShieldCheck,
    Users,
} from "lucide-react";
import { useTranslations } from "next-intl";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CreateRequestButton } from "@/components/create-request-button";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { hasPermission } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { useBulkActivation } from "../hooks/use-bulk-activation";

/**
 * Activation flow for confidential treasuries that don't yet have their
 * bulk-payment subaccount authenticated (treasuries created before the
 * feature existed, or whose setup step failed).
 *
 * One round of multisig approvals is required: the flow creates a
 * `v1.signer` sign request that registers the confidential bulk access
 * key; once enough members approve it, the backend authenticates the
 * subaccount automatically and bulk payments unlock.
 */
export function BulkActivationCard() {
    const t = useTranslations("bulkActivation");
    const tCommon = useTranslations("common");
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { createProposal, accountId } = useNear();
    const { status, isLoading, isError, prepare, refetch } =
        useBulkActivation();
    const [isSubmitting, setIsSubmitting] = useState(false);
    // Synchronous lock — `isSubmitting` alone can miss rapid clicks before
    // React re-renders and disables the button.
    const isSubmittingRef = useRef(false);
    // After the wallet creates the proposal, show the awaiting UI immediately
    // so a slow status refetch cannot re-enable "Start activation".
    const [proposalSubmitted, setProposalSubmitted] = useState(false);

    // Only members with proposal rights can start activation (it creates a
    // proposal). Others — approvers, viewers — need to know they can't kick
    // it off themselves, rather than facing a bare disabled button.
    const canPropose = useMemo(
        () =>
            Boolean(
                policy &&
                    accountId &&
                    hasPermission(policy, accountId, "call", "AddProposal"),
            ),
        [policy, accountId],
    );

    // Already activated → the parent page renders the payment form instead.
    if (status === "active") {
        return null;
    }

    // Still loading (or the query is briefly disabled while `treasuryId`
    // settles): show a spinner rather than an empty page.
    if (isLoading || (!status && !isError)) {
        return (
            <Card className="mx-auto w-full max-w-[600px] min-w-0">
                <CardContent className="text-muted-foreground flex items-center justify-center p-4 sm:p-8">
                    <Loader2 className="size-6 animate-spin" />
                </CardContent>
            </Card>
        );
    }

    // Status query errored and we have nothing to show: surface the error with
    // a retry instead of stranding the user on a blank page (React Query keeps
    // `isLoading` false once it has errored).
    if (!status) {
        return (
            <Card className="mx-auto w-full max-w-[600px] min-w-0">
                <CardContent className="flex flex-col items-center gap-3 sm:gap-4 p-4 sm:p-8 text-center">
                    <AlertTriangle className="text-destructive size-8 sm:size-10" />
                    <h3 className="text-base sm:text-lg font-semibold">
                        {t("errorTitle")}
                    </h3>
                    <p className="text-muted-foreground text-sm">
                        {tCommon("tryAgain")}
                    </p>
                    <Button variant="outline" onClick={() => refetch()}>
                        {tCommon("retry")}
                    </Button>
                </CardContent>
            </Card>
        );
    }

    const awaitingApproval =
        status === "awaiting_approval" || proposalSubmitted;
    const failed = status === "failed";

    const startActivation = async () => {
        if (!treasuryId || isSubmittingRef.current) return;

        // Lock immediately (ref + state) so rapid clicks cannot create
        // duplicate prepare/proposal requests before React re-renders.
        isSubmittingRef.current = true;
        setIsSubmitting(true);
        try {
            // 1. Backend provisions the bulk subaccount (subsidized) and
            //    returns the auth proposal. Can take ~30s on first run
            //    while the on-chain MPC bootstrap settles.
            const prepared = await prepare.mutateAsync();

            // 2. User submits the proposal — the multisig then needs one
            //    round of approvals.
            await createProposal(t("proposalCreated"), {
                treasuryId,
                proposal: {
                    description: prepared.proposal.proposal.description,
                    kind: prepared.proposal.proposal.kind,
                },
                proposalBond: policy?.proposal_bond || "0",
            });

            // Flip to awaiting UI before unlocking so the Start button cannot
            // be clicked again while status is still catching up.
            setProposalSubmitted(true);
            refetch();
        } catch (error) {
            console.error("Bulk activation failed", error);
            toast.error(
                error instanceof Error ? error.message : t("activationFailed"),
            );
            isSubmittingRef.current = false;
            setIsSubmitting(false);
        }
    };

    return (
        <Card className="mx-auto w-full max-w-[600px] min-w-0">
            <CardContent className="flex flex-col items-center gap-3 sm:gap-4 p-4 sm:p-8 text-center">
                {awaitingApproval ? (
                    <>
                        <Users className="text-primary size-8 sm:size-10" />
                        <h3 className="text-base sm:text-lg font-semibold">
                            {t("awaitingTitle")}
                        </h3>
                        <p className="text-muted-foreground text-sm">
                            {t("awaitingDescription")}
                        </p>
                        <div className="text-muted-foreground flex items-center gap-2 text-xs">
                            <CheckCircle2 className="size-4 shrink-0" />
                            {t("awaitingHint")}
                        </div>
                        <p className="text-muted-foreground text-xs">
                            {t("awaitingApproverHint")}
                        </p>
                    </>
                ) : (
                    <>
                        <ShieldCheck className="text-primary size-8 sm:size-10" />
                        <h3 className="text-base sm:text-lg font-semibold">
                            {t("introTitle")}
                        </h3>
                        <p className="text-muted-foreground text-sm">
                            {failed
                                ? t("failedDescription")
                                : t("introDescription")}
                        </p>
                        {canPropose ? (
                            <>
                                <CreateRequestButton
                                    permissions={[
                                        { kind: "call", action: "AddProposal" },
                                    ]}
                                    onClick={startActivation}
                                    isSubmitting={isSubmitting}
                                    idleMessage={
                                        failed
                                            ? t("retryButton")
                                            : t("startButton")
                                    }
                                    loadingMessage={t("preparing")}
                                />
                                <p className="text-muted-foreground text-xs">
                                    {t("approvalNote")}
                                </p>
                            </>
                        ) : (
                            <p className="text-muted-foreground text-sm">
                                {t("noPermissionNote")}
                            </p>
                        )}
                    </>
                )}
            </CardContent>
        </Card>
    );
}
