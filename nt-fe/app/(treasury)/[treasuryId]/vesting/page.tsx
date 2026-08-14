"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { useForm, useFormContext } from "react-hook-form";
import z from "zod";
import { AmountSummary } from "@/components/amount-summary";
import { PageCard } from "@/components/card";
import { CheckboxInput } from "@/components/checkbox-input";
import { CreateRequestButton } from "@/components/create-request-button";
import { DateInput } from "@/components/date-input";
import { useFormatDate } from "@/components/formatted-date";
import { InfoDisplay } from "@/components/info-display";
import { InputBlock } from "@/components/input-block";
import { PageComponentLayout } from "@/components/page-component-layout";
import { RecipientInput } from "@/components/recipient-input";
import {
    ReviewStep,
    type StepProps,
    StepperHeader,
    StepWizard,
} from "@/components/step-wizard";
import { Textarea } from "@/components/textarea";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { Form, FormField } from "@/components/ui/form";
import { LOCKUP_NO_WHITELIST_ACCOUNT_ID } from "@/constants/config";
import { default_near_token } from "@/constants/token";
import { useTreasury } from "@/hooks/use-treasury";
import { useToken, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { decimalOrNull } from "@/lib/amount-format";
import Big from "@/lib/big";
import {
    encodeToMarkdown,
    formatTimestamp,
    formatUserDate,
    jsonToBase64,
} from "@/lib/utils";
import { useNear } from "@/stores/near-store";

function buildVestingFormSchema(messages: {
    recipientMin: string;
    recipientMax64: string;
    amountMinLockup: string;
    startDateRequired: string;
    endDateRequired: string;
    cliffDateRequired: string;
    recipientSameAsToken: string;
    startBeforeEnd: string;
    cliffBetween: (start: string, end: string) => string;
}) {
    return z
        .object({
            vesting: z.object({
                address: z
                    .string()
                    .min(2, messages.recipientMin)
                    .max(64, messages.recipientMax64),
                amount: z
                    .string()
                    .refine((val) => !isNaN(Number(val)) && Big(val).gte(3.5), {
                        message: messages.amountMinLockup,
                    }),
                memo: z.string().optional(),
                isRegistered: z.boolean().optional(),
                token: tokenSchema,
                startDate: z.date({ message: messages.startDateRequired }),
                endDate: z.date({ message: messages.endDateRequired }),
                cliffDate: z
                    .date({ message: messages.cliffDateRequired })
                    .optional(),
                allowEarn: z.boolean().optional(),
                allowCancel: z.boolean().optional(),
            }),
        })
        .superRefine((data, ctx) => {
            if (data.vesting.address === data.vesting.token.address) {
                ctx.addIssue({
                    code: "custom",
                    path: [`vesting.address`],
                    message: messages.recipientSameAsToken,
                });
            }
            if (data.vesting.startDate >= data.vesting.endDate) {
                ctx.addIssue({
                    code: "custom",
                    path: [`vesting.endDate`],
                    message: messages.startBeforeEnd,
                });
            }

            if (data.vesting.cliffDate) {
                if (
                    data.vesting.cliffDate < data.vesting.startDate ||
                    data.vesting.cliffDate >= data.vesting.endDate
                ) {
                    ctx.addIssue({
                        code: "custom",
                        path: [`vesting.cliffDate`],
                        message: messages.cliffBetween(
                            formatUserDate(data.vesting.startDate, {
                                includeTime: false,
                            }),
                            formatUserDate(data.vesting.endDate, {
                                includeTime: false,
                            }),
                        ),
                    });
                }
            }
        });
}

type VestingFormValues = z.infer<ReturnType<typeof buildVestingFormSchema>>;

function Step1({ handleNext }: StepProps) {
    const tV = useTranslations("vesting");
    const form = useFormContext<VestingFormValues>();
    const startDate = form.watch("vesting.startDate");
    const endDate = form.watch("vesting.endDate");

    const handleContinue = () => {
        form.trigger([
            "vesting.address",
            "vesting.startDate",
            "vesting.endDate",
            "vesting.amount",
        ]).then((isValid) => {
            if (isValid && handleNext) {
                handleNext();
            }
        });
    };

    return (
        <PageCard>
            <StepperHeader title={tV("heading")} />
            <TokenInput
                title={tV("amount")}
                tokenSelect={{
                    locked: true,
                }}
                control={form.control}
                amountName={`vesting.amount`}
                tokenName={`vesting.token`}
            />
            <RecipientInput control={form.control} name="vesting.address" />

            <div className="grid grid-cols-2 gap-4">
                <DateInput
                    control={form.control}
                    name="vesting.startDate"
                    title={tV("startDate")}
                    maxDate={endDate}
                />
                <DateInput
                    control={form.control}
                    name="vesting.endDate"
                    title={tV("endDate")}
                    minDate={startDate}
                />
            </div>

            <CreateRequestButton
                onClick={handleContinue}
                permissions={{ kind: "call", action: "AddProposal" }}
                idleMessage={tV("continue")}
            />
        </PageCard>
    );
}

function Step2({ handleBack, handleNext }: StepProps) {
    const tV = useTranslations("vesting");
    const form = useFormContext<VestingFormValues>();
    const allowCancel = form.watch("vesting.allowCancel");
    const startDate = form.watch("vesting.startDate");
    const endDate = form.watch("vesting.endDate");

    const handleReview = () => {
        form.trigger().then((isValid) => {
            if (isValid && handleNext) {
                handleNext();
            }
        });
    };

    return (
        <PageCard>
            <StepperHeader
                title={tV("advancedSettings")}
                handleBack={handleBack}
            />
            <CheckboxInput
                control={form.control}
                name="vesting.allowCancel"
                title={tV("allowCancellation")}
                description={tV("allowCancellationDescription")}
            />
            {allowCancel && (
                <DateInput
                    control={form.control}
                    name="vesting.cliffDate"
                    title={tV("cliffDate")}
                    minDate={startDate}
                    maxDate={endDate}
                />
            )}
            <CheckboxInput
                control={form.control}
                name="vesting.allowEarn"
                title={tV("allowEarn")}
                description={tV("allowEarnDescription")}
            />
            <FormField
                control={form.control}
                name={`vesting.memo`}
                render={({ field }) => (
                    <InputBlock title={tV("noteOptional")} invalid={false}>
                        <Textarea
                            borderless
                            value={field.value}
                            onChange={field.onChange}
                            rows={2}
                            className="p-0 pt-1"
                            placeholder={tV("commentPlaceholder")}
                        />
                    </InputBlock>
                )}
            />

            <div className="rounded-lg border bg-card p-0 overflow-hidden">
                <CreateRequestButton
                    onClick={handleReview}
                    className="w-full h-10 rounded-none"
                    permissions={{ kind: "call", action: "AddProposal" }}
                    idleMessage={tV("reviewRequest")}
                />
            </div>
        </PageCard>
    );
}

function Step3({ handleBack }: StepProps) {
    const tV = useTranslations("vesting");
    const tRev = useTranslations("vesting.review");
    const tCommon = useTranslations("common");
    const form = useFormContext<VestingFormValues>();
    const { vesting } = form.watch();
    const { data: token } = useToken(vesting.token.address);
    const formatDate = useFormatDate();

    const estimatedUSDValue = useMemo(() => {
        const price = decimalOrNull(token?.price);
        const amount = decimalOrNull(vesting.amount);
        if (!price?.gt(0) || !amount) return null;
        return amount.mul(price);
    }, [token?.price, vesting.amount]);

    const infoItems = useMemo(() => {
        const items = [
            {
                label: tRev("recipient"),
                value: vesting.address,
            },
            {
                label: tRev("startDate"),
                value: formatDate(vesting.startDate, { includeTime: false }),
            },
            {
                label: tRev("endDate"),
                value: formatDate(vesting.endDate, { includeTime: false }),
            },
            {
                label: tRev("cliffDate"),
                value: vesting.cliffDate
                    ? formatDate(vesting.cliffDate, { includeTime: false })
                    : tRev("na"),
            },
            {
                label: tRev("cancelable"),
                value: vesting.allowCancel ? tCommon("yes") : tCommon("no"),
            },
            {
                label: tRev("allowEarn"),
                value: vesting.allowEarn ? tCommon("yes") : tCommon("no"),
            },
        ];

        return items;
    }, [vesting, formatDate, tRev, tCommon]);

    return (
        <PageCard>
            <ReviewStep
                reviewingTitle={tV("reviewHeading")}
                handleBack={handleBack}
            >
                <div className="flex flex-col gap-6">
                    <AmountSummary
                        total={vesting.amount}
                        totalUSD={estimatedUSDValue}
                        token={vesting.token}
                    />
                    <InfoDisplay items={infoItems} />
                </div>
            </ReviewStep>

            <CreateRequestButton
                isSubmitting={form.formState.isSubmitting}
                type="submit"
                className="w-full h-10 rounded-none"
                permissions={{ kind: "call", action: "AddProposal" }}
                idleMessage={tV("confirmSubmit")}
            />
        </PageCard>
    );
}

export default function VestingPage() {
    const t = useTranslations("pages.vesting");
    const tV = useTranslations("vesting");
    const tSteps = useTranslations("vesting.stepTitles");
    const tValidation = useTranslations("paymentForm.validation");
    const vestingFormSchema = useMemo(
        () =>
            buildVestingFormSchema({
                recipientMin: tValidation("recipientMin"),
                recipientMax64: tValidation("recipientMax64"),
                amountMinLockup: tValidation("amountMinLockup"),
                startDateRequired: tValidation("startDateRequired"),
                endDateRequired: tValidation("endDateRequired"),
                cliffDateRequired: tValidation("cliffDateRequired"),
                recipientSameAsToken: tValidation("recipientSameAsToken"),
                startBeforeEnd: tValidation("startBeforeEnd"),
                cliffBetween: (start, end) =>
                    tValidation("cliffBetween", { start, end }),
            }),
        [tValidation],
    );
    const { treasuryId, isConfidential } = useTreasury();
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const [step, setStep] = useState(0);

    const form = useForm<VestingFormValues>({
        resolver: zodResolver(vestingFormSchema),
        defaultValues: {
            vesting: {
                address: "",
                amount: "",
                memo: "",
                startDate: undefined,
                cliffDate: undefined,
                endDate: undefined,
                allowCancel: false,
                allowEarn: false,
                token: default_near_token(isConfidential),
            },
        },
    });

    const onSubmit = async (data: VestingFormValues) => {
        const description = {
            title: tV("proposalTitle", { address: data.vesting.address }),
            notes: data.vesting.memo || "",
        };
        const proposalBond = policy?.proposal_bond || "0";
        const deposit = Big(data.vesting.amount)
            .mul(Big(10).pow(data.vesting.token.decimals))
            .toFixed();
        const vestingArgs = data.vesting.allowCancel
            ? {
                  vesting_schedule: {
                      VestingSchedule: {
                          cliff_timestamp: formatTimestamp(
                              data.vesting.cliffDate || data.vesting.startDate,
                          ).toString(),
                          end_timestamp: formatTimestamp(
                              data.vesting.endDate,
                          ).toString(),
                          start_timestamp: formatTimestamp(
                              data.vesting.startDate,
                          ).toString(),
                      },
                  },
              }
            : {
                  lockup_timestamp: formatTimestamp(
                      data.vesting.startDate,
                  ).toString(),
                  release_duration: (
                      formatTimestamp(data.vesting.endDate) -
                      formatTimestamp(data.vesting.startDate)
                  ).toString(),
              };

        const cancellableArgs = data.vesting.allowCancel
            ? {
                  foundation_account_id: treasuryId!,
              }
            : {};
        const stakingArgs = !data.vesting.allowEarn
            ? {
                  whitelist_account_id: LOCKUP_NO_WHITELIST_ACCOUNT_ID,
              }
            : {};

        await createProposal(tV("scheduleSubmitted"), {
            treasuryId: treasuryId!,
            proposal: {
                description: encodeToMarkdown(description),
                kind: {
                    FunctionCall: {
                        receiver_id: "lockup.near",
                        actions: [
                            {
                                method_name: "create",
                                args: jsonToBase64({
                                    lockup_duration: "0",
                                    owner_account_id: data.vesting.address,
                                    ...vestingArgs,
                                    ...cancellableArgs,
                                    ...stakingArgs,
                                }),
                                deposit,
                                gas: "150000000000000",
                            },
                        ],
                    },
                },
            },
            proposalBond,
            proposalType: "other",
        })
            .then(() => {
                form.reset();
                setStep(0);
            })
            .catch((error) => {
                console.error("Vesting error", error);
            });
    };

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <Form {...form}>
                <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="flex flex-col gap-4 max-w-[600px] mx-auto"
                >
                    <StepWizard
                        step={step}
                        onStepChange={setStep}
                        stepTitles={[
                            tSteps("details"),
                            tSteps("settings"),
                            tSteps("review"),
                        ]}
                        steps={[
                            {
                                component: Step1,
                            },
                            {
                                component: Step2,
                            },
                            {
                                component: Step3,
                            },
                        ]}
                    />
                </form>
            </Form>
        </PageComponentLayout>
    );
}
