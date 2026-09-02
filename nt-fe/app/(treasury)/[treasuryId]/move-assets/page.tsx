"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { Shield01Icon } from "@hugeicons/core-free-icons";
import { useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { useCallback, useMemo, useState } from "react";
import { useForm, useFormContext, useWatch } from "react-hook-form";
import { z } from "zod";
import { Address } from "@/components/address";
import { AmountSummary } from "@/components/amount-summary";
import { PageCard } from "@/components/card";
import { CreateRequestButton } from "@/components/create-request-button";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
    ReviewStep,
    type StepProps,
    StepperHeader,
    StepWizard,
} from "@/components/step-wizard";
import { Textarea } from "@/components/textarea";
import { TokenDisplay } from "@/components/token-display-with-network";
import { type Token, tokenSchema } from "@/components/token-input";
import { Tooltip } from "@/components/tooltip";
import { Form, FormField } from "@/components/ui/form";
import { PublicAssetsTable } from "@/features/confidential/components/public-assets-table";
import { usePendingMoveRequests } from "@/features/confidential/hooks/use-pending-move-requests";
import {
    PUBLIC_ASSETS_QUERY_KEY,
    usePublicAssets,
} from "@/features/confidential/hooks/use-public-assets";
import {
    parsePublicTransferAmount,
    preparePublicToConfidentialTransfer,
    publicAssetToToken,
} from "@/features/confidential/utils/public-to-confidential";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { decimalOrNull } from "@/lib/amount-format";
import { trackEvent } from "@/lib/analytics";
import { refreshConfidentialHistory, type TreasuryAsset } from "@/lib/api";
import { hasPermission } from "@/lib/config-utils";
import { useNear } from "@/stores/near-store";
import { PaymentFormSection } from "../payments/components/payment-form-section";

const MOVE_PERMISSION = { kind: "call", action: "AddProposal" } as const;

function buildMoveFormSchema(
    asset: TreasuryAsset,
    messages: Record<
        "invalid" | "zero" | "tooManyDecimals" | "exceedsBalance",
        string
    >,
) {
    return z.object({
        token: tokenSchema,
        address: z.string().min(2),
        memo: z.string().optional(),
        amount: z.string().superRefine((value, ctx) => {
            const parsed = parsePublicTransferAmount(value, asset);
            if (!parsed.ok) {
                ctx.addIssue({
                    code: "custom",
                    message: messages[parsed.error],
                });
            }
        }),
    });
}

type MoveFormValues = z.infer<ReturnType<typeof buildMoveFormSchema>>;

interface StepBaseProps extends StepProps {
    onExit: () => void;
}

function SendStep({ handleNext, onExit }: StepBaseProps) {
    const t = useTranslations("moveAssets");
    const tCommon = useTranslations("common");
    const form = useFormContext<MoveFormValues>();
    const amount = form.watch("amount");

    const handleSave = async () => {
        const isValid = await form.trigger();
        if (isValid) handleNext?.();
    };

    const hasAmount = !!decimalOrNull(amount)?.gt(0);

    return (
        <PageCard>
            <StepperHeader
                title={
                    <span className="inline-flex items-center gap-1.5">
                        <span>{t("form.title")}</span>
                        <Tooltip content={tCommon("confidentialDataTooltip")}>
                            <span className="inline-flex">
                                <Icon
                                    icon={Shield01Icon}
                                    className="size-4 fill-foreground"
                                />
                            </span>
                        </Tooltip>
                    </span>
                }
                handleBack={onExit}
            />
            <PaymentFormSection
                control={form.control}
                amountName="amount"
                tokenName="token"
                recipientName="address"
                tokenLocked
                recipientLocked
                balanceFromToken
                hideRecipientNetwork
                savePermissions={MOVE_PERMISSION}
                saveButtonText={
                    hasAmount ? t("form.review") : t("form.reviewDisabled")
                }
                onSave={handleSave}
            />
        </PageCard>
    );
}

function ReviewMoveStep({ handleBack }: StepBaseProps) {
    const t = useTranslations("moveAssets");
    const tPay = useTranslations("payments");
    const form = useFormContext<MoveFormValues>();
    const [token, amount, address] = useWatch({
        control: form.control,
        name: ["token", "amount", "address"],
    }) as [Token, string, string];

    const parsedAmount = decimalOrNull(amount);
    const price = decimalOrNull(token.price);
    const usdValue =
        parsedAmount && price?.gt(0) ? parsedAmount.mul(price) : null;

    return (
        <PageCard>
            <ReviewStep
                reviewingTitle={t("review.title")}
                handleBack={handleBack}
            >
                <AmountSummary
                    title={t("review.youMove")}
                    total={parsedAmount}
                    totalUSD={usdValue}
                    token={token}
                    showNetworkIcon
                />
                <div className="flex justify-between items-center gap-2 w-full text-xs">
                    <Address address={address} className="font-semibold" />
                    <div className="flex items-center gap-5 min-w-fit">
                        <TokenDisplay
                            icon={token.icon}
                            symbol={token.symbol}
                            chainIcons={token.chainIcons ?? undefined}
                        />
                        <div className="flex flex-col gap-[3px] items-end">
                            <p className="text-xs font-semibold text-wrap break-all">
                                <FormattedAmount
                                    kind="token"
                                    value={parsedAmount}
                                    symbol={token.symbol}
                                    tokenDecimals={token.decimals}
                                    unitPriceUsd={token.price}
                                    profile="standard"
                                />
                            </p>
                            {usdValue ? (
                                <p className="text-xxs text-muted-foreground text-wrap break-all">
                                    ≈{" "}
                                    <FormattedAmount
                                        kind="fiat"
                                        value={usdValue}
                                    />
                                </p>
                            ) : null}
                        </div>
                    </div>
                </div>
                <FormField
                    control={form.control}
                    name="memo"
                    render={({ field }) => (
                        <Textarea
                            value={field.value}
                            onChange={field.onChange}
                            borderless
                            rows={2}
                            placeholder={tPay("commentPlaceholder")}
                        />
                    )}
                />
            </ReviewStep>
            <div className="rounded-lg border bg-card p-0 overflow-hidden">
                <CreateRequestButton
                    isSubmitting={form.formState.isSubmitting}
                    type="submit"
                    className="w-full h-10 rounded-none"
                    permissions={MOVE_PERMISSION}
                    idleMessage={tPay("confirmSubmit")}
                />
            </div>
        </PageCard>
    );
}

interface MoveAssetWizardProps {
    asset: TreasuryAsset;
    onExit: () => void;
}

function MoveAssetWizard({ asset, onExit }: MoveAssetWizardProps) {
    const t = useTranslations("moveAssets");
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { createProposal } = useNear();
    const queryClient = useQueryClient();
    const [step, setStep] = useState(0);

    const schema = useMemo(
        () =>
            buildMoveFormSchema(asset, {
                invalid: t("errors.invalid"),
                zero: t("errors.zero"),
                tooManyDecimals: t("errors.tooManyDecimals"),
                exceedsBalance: t("errors.exceedsBalance"),
            }),
        [asset, t],
    );

    const form = useForm<MoveFormValues>({
        resolver: zodResolver(schema),
        defaultValues: {
            token: publicAssetToToken(asset),
            address: treasuryId ?? "",
            amount: "",
            memo: "",
        },
    });

    const onSubmit = async (data: MoveFormValues) => {
        if (!treasuryId || !policy) return;
        const parsed = parsePublicTransferAmount(data.amount, asset);
        if (!parsed.ok) return;

        try {
            const { proposal } = await preparePublicToConfidentialTransfer({
                treasuryId,
                asset,
                amountRaw: parsed.raw,
                proposalPeriod: policy.proposal_period,
                notes: data.memo,
            });
            await createProposal(t("submitted"), {
                treasuryId,
                proposal,
                proposalBond: policy.proposal_bond || "0",
                proposalType: "payment",
            });
            trackEvent("confidential-move-assets-submitted", {
                treasury_id: treasuryId,
                token_symbol: asset.symbol,
                residency: asset.residency,
            });
            // Pull the quote into confidential history right away so the
            // request is bound (and labelled) without waiting for the poller.
            await refreshConfidentialHistory(treasuryId).catch(() => null);
            queryClient.invalidateQueries({
                queryKey: [PUBLIC_ASSETS_QUERY_KEY, treasuryId],
            });
            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });
            onExit();
        } catch (error) {
            console.error("Move assets error", error);
            form.setError("amount", {
                type: "manual",
                message:
                    error instanceof Error ? error.message : t("errors.failed"),
            });
            setStep(0);
        }
    };

    const steps = useMemo(
        () => [
            { component: SendStep, props: { onExit } },
            { component: ReviewMoveStep, props: { onExit } },
        ],
        [onExit],
    );

    return (
        <Form {...form}>
            <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="flex flex-col gap-4 max-w-[600px] mx-auto"
            >
                <StepWizard step={step} onStepChange={setStep} steps={steps} />
            </form>
        </Form>
    );
}

export default function MoveAssetsPage() {
    const t = useTranslations("moveAssets");
    const { treasuryId, isConfidential, isGuestTreasury } = useTreasury();
    const { accountId } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { data, isLoading } = usePublicAssets();
    const [selectedAsset, setSelectedAsset] = useState<TreasuryAsset | null>(
        null,
    );

    const canMove = useMemo(
        () =>
            Boolean(
                policy &&
                    accountId &&
                    hasPermission(policy, accountId, "call", "AddProposal"),
            ),
        [policy, accountId],
    );

    const pendingRequests = usePendingMoveRequests(data?.tokens);

    const exitWizard = useCallback(() => setSelectedAsset(null), []);

    const showList = isConfidential && !isGuestTreasury;

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            {selectedAsset ? (
                <MoveAssetWizard
                    key={`${selectedAsset.id}:${selectedAsset.residency}`}
                    asset={selectedAsset}
                    onExit={exitWizard}
                />
            ) : (
                <div className="flex justify-center w-full">
                    <div className="flex-1 max-w-[900px] w-full min-w-[300px]">
                        <PublicAssetsTable
                            tokens={showList ? (data?.tokens ?? []) : []}
                            isLoading={showList && isLoading}
                            canMove={canMove}
                            pendingRequests={pendingRequests}
                            onMove={setSelectedAsset}
                        />
                    </div>
                </div>
            )}
        </PageComponentLayout>
    );
}
