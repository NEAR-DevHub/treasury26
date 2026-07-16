"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { trackEvent } from "@/lib/analytics";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepWizard } from "@/components/step-wizard";
import { Form } from "@/components/ui/form";
import {
    PAGE_TOUR_NAMES,
    PAGE_TOUR_STORAGE_KEYS,
    usePageTour,
} from "@/features/onboarding/steps/page-tours";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useBridgeAssetsForWarnings,
    useBridgeScopedWarning,
} from "@/hooks/use-warnings";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import type { IntentsQuoteResponse } from "@/lib/api";
import { generateIntent } from "@/lib/api";
import { parseTokenQueryParam } from "@/lib/token-query-param";
import { buildConfidentialProposal } from "../../../../features/confidential/utils/proposal-builder";
import { useNear } from "@/stores/near-store";
import { Step1 } from "./components/step1";
import { Step2 } from "./components/step2";
import { BTC_TOKEN, ETH_TOKEN } from "./constants";
import {
    buildExchangeFormSchema,
    type ExchangeFormValues,
} from "./exchange-form";
import { isNativeNEAR, isNEARDeposit, isNEARWithdraw } from "./utils";
import {
    buildFungibleTokenProposal,
    buildNativeNEARProposal,
    buildNEARDepositProposal,
    buildNEARWithdrawProposal,
} from "./utils/proposal-builder";

export default function ExchangePage() {
    const t = useTranslations("pages.exchange");
    const tEx = useTranslations("exchange");
    const tValidation = useTranslations("paymentForm.validation");
    const exchangeFormSchema = useMemo(
        () =>
            buildExchangeFormSchema({
                amountGreaterThanZero: tValidation("amountGreaterThanZero"),
            }),
        [tValidation],
    );
    const { treasuryId: selectedTreasury, isConfidential } = useTreasury();
    const pageTitle = isConfidential ? t("confidentialTitle") : t("title");
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(selectedTreasury);
    const [step, setStep] = useState(0);
    const searchParams = useSearchParams();

    // Parse sellToken from query params
    const defaultSellToken = useMemo(() => {
        const sellTokenParam = searchParams.get("sellToken");
        return parseTokenQueryParam(sellTokenParam, BTC_TOKEN);
    }, [searchParams]);

    // Onboarding tour
    usePageTour(
        PAGE_TOUR_NAMES.EXCHANGE_SETTINGS,
        PAGE_TOUR_STORAGE_KEYS.EXCHANGE_SETTINGS_SHOWN,
    );

    const form = useForm<ExchangeFormValues>({
        resolver: zodResolver(exchangeFormSchema),
        defaultValues: {
            sellAmount: "",
            sellToken: defaultSellToken,
            receiveAmount: "",
            receiveToken: ETH_TOKEN,
            slippageTolerance: 0.5,
            amountMode: "EXACT_INPUT",
        },
    });

    // Update sellToken when query param changes
    useEffect(() => {
        form.setValue("sellToken", defaultSellToken);
    }, [defaultSellToken, form]);

    const watchedSellToken = form.watch("sellToken");
    const { data: bridgeAssets = [] } = useBridgeAssetsForWarnings("exchange");
    const { blocked: exchangeSlotBlocked, message: exchangeSlotMessage } =
        useBridgeScopedWarning(
            "exchange",
            bridgeAssets,
            watchedSellToken?.address,
        );

    const onSubmit = async (data: ExchangeFormValues) => {
        const proposalDataFromForm = (
            form.getValues as (name: string) => unknown
        )("proposalData") as IntentsQuoteResponse | null;

        if (!proposalDataFromForm || !selectedTreasury) {
            console.error("Missing proposal data or treasury");
            return;
        }

        if (exchangeSlotBlocked) {
            if (exchangeSlotMessage) toast.error(exchangeSlotMessage);
            return;
        }

        try {
            const proposalBond = policy?.proposal_bond || "0";

            if (isConfidential) {
                // Confidential path: generate intent + build v1.signer proposal
                const { correlationId: _, ...quoteMetadata } =
                    proposalDataFromForm as unknown as Record<string, unknown>;
                const intentResponse = await generateIntent({
                    type: "swap_transfer",
                    standard: "nep413",
                    signerId: selectedTreasury,
                    quoteMetadata,
                });

                const confidentialResult = buildConfidentialProposal({
                    intentResponse,
                    treasuryId: selectedTreasury,
                });

                await createProposal(tEx("requestSubmitted"), {
                    treasuryId: selectedTreasury,
                    proposal: confidentialResult.proposal,
                    proposalBond,
                    proposalType: "swap",
                });
            } else {
                const sellingNativeNEAR = isNativeNEAR(
                    data.sellToken.address,
                    data.sellToken.residency,
                );

                const proposalParams = {
                    proposalData: proposalDataFromForm,
                    sellToken: data.sellToken,
                    receiveToken: data.receiveToken,
                    slippageTolerance: data.slippageTolerance || 0.5,
                    treasuryId: selectedTreasury,
                    proposalBond,
                };

                let result;

                // Detect NEAR deposit: native NEAR -> FT NEAR (wrap.near)
                if (isNEARDeposit(data.sellToken, data.receiveToken)) {
                    result = await buildNEARDepositProposal(proposalParams);
                }
                // Detect NEAR withdraw: FT NEAR (wrap.near) -> native NEAR
                else if (isNEARWithdraw(data.sellToken, data.receiveToken)) {
                    result = buildNEARWithdrawProposal(proposalParams);
                }
                // Regular exchange: native NEAR to other tokens
                else if (sellingNativeNEAR) {
                    result = await buildNativeNEARProposal(proposalParams);
                }
                // Regular exchange: FT tokens or intents tokens
                else {
                    result = await buildFungibleTokenProposal(proposalParams);
                }

                await createProposal(tEx("requestSubmitted"), {
                    treasuryId: selectedTreasury,
                    proposal: result.proposal,
                    proposalBond,
                    proposalType: "swap",
                });
            }

            trackEvent("exchange-submitted", {
                treasury_id: selectedTreasury,
                sell_token_symbol: data.sellToken.symbol,
                receive_token_symbol: data.receiveToken.symbol,
            });

            form.reset();
            setStep(0);
        } catch (error: unknown) {
            console.error("Exchange error", error);
        }
    };

    return (
        <PageComponentLayout title={pageTitle} description={t("description")}>
            <Form {...form}>
                <form
                    onSubmit={(e) => {
                        // Only allow submission from Step 2 (Review step)
                        if (step !== 1) {
                            e.preventDefault();
                            return;
                        }
                        form.handleSubmit(onSubmit)(e);
                    }}
                    className="flex flex-col gap-4 max-w-[600px] mx-auto"
                >
                    <StepWizard
                        step={step}
                        onStepChange={setStep}
                        steps={[
                            {
                                component: Step1,
                                props: { bridgeAssets },
                            },
                            {
                                component: Step2,
                            },
                        ]}
                    />
                </form>
            </Form>
        </PageComponentLayout>
    );
}
