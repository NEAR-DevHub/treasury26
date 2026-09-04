"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepWizard } from "@/components/step-wizard";
import { Form } from "@/components/ui/form";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import {
    useBridgeAssetsForWarnings,
    useBridgeScopedWarning,
} from "@/hooks/use-warnings";
import { trackEvent } from "@/lib/analytics";
import type { IntentsQuoteResponse } from "@/lib/api";
import { generateIntent } from "@/lib/api";
import { useMergedTokens } from "@/hooks/use-merged-tokens";
import { pickDefaultSwapPair } from "@/lib/pick-default-token";
import { parseTokenQueryParam } from "@/lib/token-query-param";
import { useNear } from "@/stores/near-store";
import { buildConfidentialProposal } from "../../../../features/confidential/utils/proposal-builder";
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

    const sellTokenParam = searchParams.get("sellToken");
    const querySellToken = useMemo(
        () => parseTokenQueryParam(sellTokenParam, BTC_TOKEN),
        [sellTokenParam],
    );
    const { tokens, isAssetsReady } = useMergedTokens();
    const appliedSwapDefault = useRef(false);

    const form = useForm<ExchangeFormValues>({
        resolver: zodResolver(exchangeFormSchema),
        defaultValues: {
            sellAmount: "",
            sellToken: querySellToken,
            receiveAmount: "",
            receiveToken:
                querySellToken.address === ETH_TOKEN.address &&
                querySellToken.network === ETH_TOKEN.network
                    ? BTC_TOKEN
                    : ETH_TOKEN,
            slippageTolerance: 0.5,
            amountMode: "EXACT_INPUT",
            comment: "",
        },
    });

    // Query param wins. Otherwise reuse the payments highest-USD default
    // once holdings are ready, and keep receive as ETH (BTC if send is ETH).
    useEffect(() => {
        if (sellTokenParam) {
            form.setValue("sellToken", querySellToken);
            form.setValue(
                "receiveToken",
                querySellToken.address === ETH_TOKEN.address &&
                    querySellToken.network === ETH_TOKEN.network
                    ? BTC_TOKEN
                    : ETH_TOKEN,
            );
            return;
        }

        if (!isAssetsReady || appliedSwapDefault.current) return;

        const currentSell = form.getValues("sellToken");
        const currentReceive = form.getValues("receiveToken");
        const stillInitialPair =
            currentSell.address === BTC_TOKEN.address &&
            currentSell.network === BTC_TOKEN.network &&
            currentReceive.address === ETH_TOKEN.address &&
            currentReceive.network === ETH_TOKEN.network;
        if (!stillInitialPair) return;

        appliedSwapDefault.current = true;
        const { sellToken, receiveToken } = pickDefaultSwapPair(
            tokens,
            {
                sell: BTC_TOKEN,
                receive: ETH_TOKEN,
                receiveIfSellMatches: BTC_TOKEN,
            },
            {
                disableTokens: isConfidential
                    ? (token) => token.residency !== "Intents"
                    : undefined,
            },
        );
        form.setValue("sellToken", sellToken);
        form.setValue("receiveToken", receiveToken);
    }, [
        sellTokenParam,
        querySellToken,
        isAssetsReady,
        tokens,
        isConfidential,
        form,
    ]);

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
                    comment: data.comment?.trim() || undefined,
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

            appliedSwapDefault.current = false;
            form.reset();
            setStep(0);
        } catch (error: unknown) {
            console.error("Exchange error", error);
        }
    };

    return (
        <PageComponentLayout
            title={pageTitle}
            backButton={selectedTreasury ? `/${selectedTreasury}` : true}
            backKind="section"
            hideMobileShellControls
            hideTitle={step === 1}
        >
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
                    className="mx-auto flex max-w-lg flex-col gap-4"
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
