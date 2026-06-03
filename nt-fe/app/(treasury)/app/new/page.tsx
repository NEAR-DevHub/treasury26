"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Clock10, Database, Globe, Shield } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm, useFormContext } from "react-hook-form";
import z from "zod";
import { Alert, AlertDescription } from "@/components/alert";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CreationDisabledModal } from "@/components/creation-disabled-modal";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
    InlineNextButton,
    type StepProps,
    StepperHeader,
    StepWizard,
} from "@/components/step-wizard";
import { Form, FormField, FormMessage } from "@/components/ui/form";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryCreationStatus } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import {
    type CreateTreasuryRequest,
    checkHandleUnused,
    createTreasuryStream,
} from "@/lib/api";
import {
    CreationProgressModal,
    type CreationStep,
} from "@/components/creation-progress-modal";
import { useNear } from "@/stores/near-store";
import { InfoAlert } from "@/components/info-alert";
import { TreasuryTypeIcon } from "@/components/icons/shield";
import {
    OnboardingQuestionsStep,
    ONBOARDING_ABOUT_DEFAULT_VALUES,
    ONBOARDING_ABOUT_SCHEMA,
    ONBOARDING_QUESTIONNAIRE_STEP_COUNT,
} from "@/features/onboarding/components/onboarding-questions-step";
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { Pill } from "@/components/pill";
import { cn } from "@/lib/utils";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";

function buildTreasuryFormSchema(messages: {
    nameMin: string;
    nameMax: string;
    accountMin: string;
    accountMax: string;
    accountChars: string;
    accountTaken: string;
}) {
    return z.object({
        about: ONBOARDING_ABOUT_SCHEMA,
        details: z
            .object({
                treasuryName: z
                    .string()
                    .min(2, messages.nameMin)
                    .max(64, messages.nameMax),
                accountName: z
                    .string()
                    .min(2, messages.accountMin)
                    .max(64, messages.accountMax)
                    .regex(/^[a-z0-9-]+$/, messages.accountChars),
            })
            .refine(
                async (data) => {
                    if (!data.accountName) return true;
                    const fullAccountId = `${data.accountName}.sputnik-dao.near`;
                    const result = await checkHandleUnused(fullAccountId);
                    return result?.unused === true;
                },
                {
                    message: messages.accountTaken,
                    path: ["accountName"],
                },
            ),
        isConfidential: z.boolean(),
    });
}

type TreasuryFormValues = z.infer<ReturnType<typeof buildTreasuryFormSchema>>;

/**
 * Helper to clear form errors before updating field value
 * Ensures errors disappear immediately when user starts typing
 */
function createClearErrorsOnChange<T>(
    form: ReturnType<typeof useFormContext<TreasuryFormValues>>,
    fieldName: string,
    hasError: boolean,
    onChange: (value: T) => void,
) {
    return (value: T) => {
        if (hasError) {
            form.clearErrors(fieldName as any);
        }
        onChange(value);
    };
}

function TreasuryDetailsStep({ handleNext, handleBack }: StepProps) {
    const tCreate = useTranslations("createTreasury");
    const form = useFormContext<TreasuryFormValues>();
    const [accountNameEdited, setAccountNameEdited] = useState(false);

    const handleContinue = async () => {
        const isValid = await form.trigger([
            "details.treasuryName",
            "details.accountName",
        ]);
        if (isValid && handleNext) {
            trackEvent("onboarding_step_completed", {
                step_name: "details",
            });
            handleNext();
        }
    };

    return (
        <PageCard>
            <StepperHeader title={tCreate("heading")} handleBack={handleBack} />

            <FormField
                control={form.control}
                name="details.treasuryName"
                render={({ field, fieldState }) => (
                    <InputBlock
                        title={tCreate("treasuryName")}
                        invalid={!!fieldState.error}
                        interactive
                    >
                        <LargeInput
                            borderless
                            placeholder={tCreate("treasuryNamePlaceholder")}
                            value={field.value}
                            onChange={(e) => {
                                // Clear errors and update field
                                createClearErrorsOnChange(
                                    form,
                                    "details.treasuryName",
                                    !!fieldState.error,
                                    field.onChange,
                                )(e);

                                // Auto-generate account name from treasury name only if user hasn't manually edited it
                                if (!accountNameEdited) {
                                    const generatedHandle = e.target.value
                                        .toLowerCase()
                                        .replace(/[^a-z0-9-]/g, "-")
                                        .replace(/-+/g, "-")
                                        .replace(/^-|-$/g, "")
                                        .slice(0, 64);
                                    form.setValue(
                                        "details.accountName",
                                        generatedHandle,
                                    );
                                    form.clearErrors("details.accountName");
                                }
                            }}
                        />
                        {fieldState.error ? (
                            <FormMessage />
                        ) : (
                            <p className="text-muted-foreground text-xs invisible">
                                Error placeholder
                            </p>
                        )}
                    </InputBlock>
                )}
            />

            <FormField
                control={form.control}
                name="details.accountName"
                render={({ field, fieldState }) => (
                    <InputBlock
                        title={tCreate("accountName")}
                        interactive
                        info={tCreate("accountNameInfo")}
                        invalid={!!fieldState.error}
                    >
                        <LargeInput
                            borderless
                            placeholder={tCreate("accountPlaceholder")}
                            suffix=".sputnik-dao.near"
                            value={field.value}
                            onChange={(e) => {
                                setAccountNameEdited(true);
                                const input = e.target.value
                                    .toLowerCase()
                                    .replace(/[^a-z0-9_-]/g, "")
                                    .slice(0, 64);
                                field.onChange(input);
                                form.clearErrors("details.accountName");
                            }}
                        />
                        {fieldState.error ? (
                            <FormMessage />
                        ) : (
                            <p className="text-muted-foreground text-xs invisible">
                                Error placeholder
                            </p>
                        )}
                    </InputBlock>
                )}
            />

            <InlineNextButton
                text={tCreate("continue")}
                onClick={handleContinue}
            />
        </PageCard>
    );
}

export function TreasuryTypePill({
    type,
}: {
    type: "confidential" | "public";
}) {
    const tCreate = useTranslations("createTreasury");
    const pillStyle = type === "confidential" ? "primary" : "card";
    const pillTitle =
        type === "confidential" ? tCreate("confidential") : tCreate("public");
    const pillIcon =
        type === "confidential" ? (
            <Shield className="size-3 text-primary-foreground" />
        ) : (
            <Globe className="size-3 text-foreground" />
        );

    return (
        <Pill
            icon={pillIcon}
            title={pillTitle}
            variant={pillStyle}
            className="shrink-0 h-fit"
        />
    );
}

export function Feature({
    title,
    icon,
}: {
    title: string;
    icon: "anyone" | "team" | "soon";
}) {
    const tCreate = useTranslations("createTreasury");
    const pillStyle =
        icon === "anyone"
            ? "secondary"
            : icon === "team"
              ? "secondary"
              : "secondary";
    const pillTitle =
        icon === "anyone"
            ? tCreate("anyone")
            : icon === "team"
              ? tCreate("teamOnly")
              : tCreate("soon");
    const pillIcon =
        icon === "anyone" ? (
            <Globe className="size-3 text-foreground" />
        ) : icon === "team" ? (
            <Shield className="size-3 text-foreground" />
        ) : (
            <Clock10 className="size-3 text-foreground" />
        );

    return (
        <div className="flex w-full items-center gap-2">
            <p
                className={cn(
                    "text-foreground text-sm w-full",
                    icon === "soon" && "text-muted-foreground",
                )}
            >
                {title}
            </p>
            <Pill
                icon={pillIcon}
                title={pillTitle}
                variant={pillStyle}
                className={cn(
                    "shrink-0",
                    icon === "team" &&
                        "bg-black text-white dark:bg-white dark:text-black [&_svg]:text-white dark:[&_svg]:text-black",
                )}
            />
        </div>
    );
}

function TreasuryTypeSelectionStep({ handleBack, handleNext }: StepProps) {
    const tCreate = useTranslations("createTreasury");
    const TREASURY_TYPES = useMemo(
        () => [
            {
                isConfidential: false,
                label: tCreate("public"),
                description: tCreate("publicDescription"),
                visibleOnChain: [
                    <Feature
                        key="bal-pub"
                        title={tCreate("balanceTransactions")}
                        icon="anyone"
                    />,
                    <Feature
                        key="mem-pub"
                        title={tCreate("membersVoting")}
                        icon="anyone"
                    />,
                ],
                featuresAvailable: {
                    generalText: tCreate("allFeatures"),
                    features: [] as React.ReactNode[],
                },
            },
            {
                isConfidential: true,
                label: tCreate("confidential"),
                description: tCreate("confidentialDescription"),
                visibleOnChain: [
                    <Feature
                        key="bal-conf"
                        title={tCreate("balanceTransactions")}
                        icon="team"
                    />,
                    <Feature
                        key="mem-conf"
                        title={tCreate("membersVoting")}
                        icon="anyone"
                    />,
                ],
                featuresAvailable: {
                    generalText: tCreate("mostFeaturesSupported"),
                    features: [
                        <Feature
                            key="export"
                            title={tCreate("recentTransactionsExport")}
                            icon="soon"
                        />,
                        <Feature
                            key="bulk"
                            title={tCreate("bulkPayment")}
                            icon="soon"
                        />,
                    ] as React.ReactNode[],
                },
            },
        ],
        [tCreate],
    );
    const form = useFormContext<TreasuryFormValues>();
    const handleSelect = (type: "confidential" | "public") => {
        form.setValue("isConfidential", type === "confidential");
        trackEvent("onboarding_step_completed", {
            step_name: "treasury_type",
            treasury_type: type,
        });
        if (handleNext) {
            handleNext();
        }
    };
    return (
        <PageCard>
            <StepperHeader
                title={tCreate("treasuryType")}
                handleBack={handleBack}
            />
            <InfoAlert message={tCreate("treasuryTypeWarning")} />
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {TREASURY_TYPES.map((type) => (
                    <Card key={type.isConfidential ? "confidential" : "public"}>
                        <CardHeader className="px-4">
                            <div className="flex items-center gap-2">
                                <TreasuryTypeIcon
                                    type={
                                        type.isConfidential
                                            ? "confidential"
                                            : "public"
                                    }
                                />
                                <CardTitle>{type.label}</CardTitle>
                            </div>
                            <CardDescription className="text-xs">
                                {type.description}
                            </CardDescription>
                        </CardHeader>
                        <CardContent className="px-4 flex flex-col gap-6">
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-muted-foreground uppercase">
                                    {tCreate("visibleOnChain")}
                                </p>
                                {type.visibleOnChain}
                            </div>
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-muted-foreground uppercase">
                                    {tCreate("featuresAvailable")}
                                </p>
                                <p className="text-sm text-foreground">
                                    {type.featuresAvailable.generalText}
                                </p>
                                {type.featuresAvailable.features}
                            </div>
                        </CardContent>
                        <CardFooter className="mt-auto px-4">
                            <Button
                                variant="default"
                                type="button"
                                className="w-full"
                                onClick={() =>
                                    handleSelect(
                                        type.isConfidential
                                            ? "confidential"
                                            : "public",
                                    )
                                }
                            >
                                {tCreate("select")}
                            </Button>
                        </CardFooter>
                    </Card>
                ))}
            </div>
        </PageCard>
    );
}

function ReviewTreasuryStep({
    handleBack,
    accountId,
    connectWallet,
    isConnectingWallet,
}: StepProps & {
    accountId: string | null;
    connectWallet: (walletId?: string) => Promise<void>;
    isConnectingWallet: boolean;
}) {
    const tCreate = useTranslations("createTreasury");
    const form = useFormContext<TreasuryFormValues>();
    const { details } = form.watch();
    const { isConfidential } = form.watch();
    const [showWalletSelector, setShowWalletSelector] = useState(false);
    if (showWalletSelector && !accountId) {
        return (
            <ConnectWalletSelector
                title={tCreate("connectWalletCreate")}
                source="/app/new"
                connectFlow="new_user"
                isConnectingWallet={isConnectingWallet}
                onBack={() => setShowWalletSelector(false)}
                onConnectSupported={connectWallet}
            />
        );
    }

    return (
        <PageCard>
            <StepperHeader
                title={tCreate("reviewTreasury")}
                handleBack={handleBack}
            />

            <div className="flex flex-col gap-2">
                <InputBlock invalid={false}>
                    <div className="flex gap-3 justify-between items-center w-full">
                        <div className="flex gap-3.5 px-3.5 py-3 items-center max-md:min-w-0">
                            <div className="size-10 rounded-[7px] bg-foreground/10 flex items-center justify-center">
                                <Database className="size-5 text-foreground" />
                            </div>
                            <div className="flex flex-col gap-0.5 max-md:min-w-0">
                                <p className="font-bold text-2xl max-md:text-xl max-md:truncate">
                                    {details.treasuryName}
                                </p>
                                <p className="text-xs text-muted-foreground max-md:truncate">
                                    {details.accountName}.sputnik-dao.near
                                </p>
                            </div>
                        </div>
                        <TreasuryTypePill
                            type={isConfidential ? "confidential" : "public"}
                        />
                    </div>
                </InputBlock>
            </div>

            <Alert variant="info">
                <AlertDescription>
                    <p className="inline-block text-xs">
                        <div className="font-semibold">
                            {tCreate("noDeploymentFee")}
                        </div>
                        {tCreate("noDeploymentFeeDescription")}
                    </p>
                </AlertDescription>
            </Alert>

            <InlineNextButton
                text={
                    accountId
                        ? tCreate("createButton")
                        : tCreate("connectWalletCreate")
                }
                loading={
                    accountId ? form.formState.isSubmitting : isConnectingWallet
                }
                onClick={
                    accountId
                        ? undefined
                        : () => {
                              setShowWalletSelector(true);
                          }
                }
            />
        </PageCard>
    );
}

export default function NewTreasuryPage() {
    const t = useTranslations("pages.createTreasury");
    const tCreate = useTranslations("createTreasury");
    const tValidation = useTranslations("createTreasury.validation");
    const tSteps = useTranslations("createTreasury.steps");
    const tStepTitles = useTranslations("createTreasury.stepTitles");
    const NON_CONFIDENTIAL_STEPS: CreationStep[] = useMemo(
        () => [
            {
                id: "creating_dao",
                label: tSteps("creatingNear"),
                status: "pending",
            },
            {
                id: "finalizing",
                label: tSteps("finalizingSetup"),
                status: "pending",
            },
        ],
        [tSteps],
    );
    const CONFIDENTIAL_STEPS: CreationStep[] = useMemo(
        () => [
            {
                id: "creating_dao",
                label: tSteps("creatingNear"),
                status: "pending",
            },
            {
                id: "adding_public_key",
                label: tSteps("registeringKey"),
                status: "pending",
            },
            {
                id: "authenticating",
                label: tSteps("settingUpConfidential"),
                status: "pending",
            },
            {
                id: "setting_policy",
                label: tSteps("configuringMembers"),
                status: "pending",
            },
            {
                id: "finalizing",
                label: tSteps("finalizingSetup"),
                status: "pending",
            },
        ],
        [tSteps],
    );
    const CREATION_STEP_TITLES = useMemo(
        () => [
            tStepTitles("aboutYou"),
            tStepTitles("details"),
            tStepTitles("treasuryType"),
            tStepTitles("review"),
        ],
        [tStepTitles],
    );
    const treasuryFormSchema = useMemo(
        () =>
            buildTreasuryFormSchema({
                nameMin: tValidation("nameMin"),
                nameMax: tValidation("nameMax"),
                accountMin: tValidation("accountMin"),
                accountMax: tValidation("accountMax"),
                accountChars: tValidation("accountChars"),
                accountTaken: tValidation("accountTaken"),
            }),
        [tValidation],
    );
    const { accountId, connect, isAuthenticating } = useNear();
    const { treasuries } = useTreasury();
    const { data: creationStatus } = useTreasuryCreationStatus();
    const creationAvailable = creationStatus?.creationAvailable ?? true;
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const isOnboardingSurveyFlow = searchParams.get("entry") === "new_user";
    const shouldSkipSurvey = !isOnboardingSurveyFlow;
    const [step, setStep] = useState(0);
    const [resumeOnboardingFromBack, setResumeOnboardingFromBack] =
        useState(false);
    const [progressOpen, setProgressOpen] = useState(false);
    const [progressSteps, setProgressSteps] = useState<CreationStep[]>([]);
    const [progressError, setProgressError] = useState<string | null>(null);
    const [createdTreasuryId, setCreatedTreasuryId] = useState<string | null>(
        null,
    );
    const previousStepRef = useRef(step);
    const form = useForm<TreasuryFormValues>({
        resolver: zodResolver(treasuryFormSchema),
        defaultValues: {
            about: ONBOARDING_ABOUT_DEFAULT_VALUES,
            details: {
                treasuryName: "",
                accountName: "",
            },
            isConfidential: false,
        },
    });

    const handleStepChange = (nextStep: number) => {
        const previousStep = previousStepRef.current;
        const isBackFromCreateTreasury =
            !shouldSkipSurvey && previousStep === 1 && nextStep === 0;
        setResumeOnboardingFromBack(isBackFromCreateTreasury);
        previousStepRef.current = nextStep;
        setStep(nextStep);
    };

    const onSubmit = async (data: TreasuryFormValues) => {
        if (!accountId) {
            await connect();
            return;
        }

        trackEvent("onboarding_step_completed", {
            step_name: "review",
        });

        const request: CreateTreasuryRequest = {
            name: data.details.treasuryName,
            accountId: `${data.details.accountName}.sputnik-dao.near`,
            paymentThreshold: 1,
            governanceThreshold: 1,
            governors: [accountId],
            isConfidential: data.isConfidential,
            financiers: [accountId],
            requestors: [accountId],
        };

        const initialSteps = request.isConfidential
            ? CONFIDENTIAL_STEPS
            : NON_CONFIDENTIAL_STEPS;

        setProgressSteps(initialSteps.map((s) => ({ ...s })));
        setProgressError(null);
        setCreatedTreasuryId(null);
        setProgressOpen(true);
        console.log(request);

        try {
            await createTreasuryStream(request, (event) => {
                if (event.step === "done") {
                    const treasuryId = event.treasury!;
                    setProgressSteps((prev) =>
                        prev.map((s) => ({
                            ...s,
                            status: "completed" as const,
                        })),
                    );
                    setCreatedTreasuryId(treasuryId);
                    trackEvent("onboarding_completed", {
                        source: "/app/new",
                        treasury_id: treasuryId,
                    });
                    trackEvent("treasury-created", {
                        source: "/app/new",
                        treasury_id: treasuryId,
                    });
                    queryClient.invalidateQueries({
                        queryKey: ["userTreasuries", accountId],
                    });
                } else if (event.step === "error") {
                    setProgressSteps((prev) =>
                        prev.map((s) =>
                            s.status === "in_progress"
                                ? { ...s, status: "error" as const }
                                : s,
                        ),
                    );
                    setProgressError(
                        event.message ?? tCreate("unexpectedError"),
                    );
                } else {
                    setProgressSteps((prev) =>
                        prev.map((s) => {
                            if (s.id === event.step) {
                                return {
                                    ...s,
                                    status: event.status as CreationStep["status"],
                                };
                            }
                            return s;
                        }),
                    );
                }
            });
        } catch (error) {
            console.error("Treasury creation error", error);
            setProgressSteps((prev) =>
                prev.map((s) =>
                    s.status === "in_progress"
                        ? { ...s, status: "error" as const }
                        : s,
                ),
            );
            setProgressError(tCreate("creationFailed"));
        }
    };

    return (
        <>
            <CreationProgressModal
                open={progressOpen}
                steps={progressSteps}
                error={progressError}
                treasuryId={createdTreasuryId}
                onClose={() => setProgressOpen(false)}
                onNavigate={() => {
                    if (createdTreasuryId) {
                        router.push(`/${createdTreasuryId}`);
                    }
                }}
            />
            <CreationDisabledModal
                open={!creationAvailable && false}
                onClose={() => router.push("/")}
            />
            <PageComponentLayout
                title={t("title")}
                hideCollapseButton
                hideLogin
                description={t("description")}
                backButton={treasuries?.length > 0 ? "/" : undefined}
            >
                <Form {...form}>
                    <form
                        onSubmit={form.handleSubmit(onSubmit)}
                        className="flex flex-col gap-4 max-w-[668px] mx-auto"
                    >
                        <StepWizard
                            step={step}
                            onStepChange={handleStepChange}
                            stepTitles={
                                shouldSkipSurvey
                                    ? CREATION_STEP_TITLES.slice(1)
                                    : CREATION_STEP_TITLES
                            }
                            stepLabelClassName="hidden md:inline"
                            steps={[
                                ...(shouldSkipSurvey
                                    ? []
                                    : [
                                          {
                                              component:
                                                  OnboardingQuestionsStep,
                                              props: {
                                                  startFromLastQuestion:
                                                      resumeOnboardingFromBack,
                                              },
                                          },
                                      ]),
                                { component: TreasuryDetailsStep },
                                { component: TreasuryTypeSelectionStep },
                                {
                                    component: ReviewTreasuryStep,
                                    props: {
                                        accountId,
                                        connectWallet: connect,
                                        isConnectingWallet: isAuthenticating,
                                    },
                                },
                            ]}
                        />
                    </form>
                </Form>
            </PageComponentLayout>
        </>
    );
}
