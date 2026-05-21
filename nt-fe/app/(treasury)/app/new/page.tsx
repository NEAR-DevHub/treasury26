"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import {
    Clock10,
    Database,
    Globe,
    Minus,
    Plus,
    Shield,
    UsersRound,
    Vote,
} from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { type ArrayPath, useForm, useFormContext } from "react-hook-form";
import z from "zod";
import { Alert, AlertDescription } from "@/components/alert";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CreationDisabledModal } from "@/components/creation-disabled-modal";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import {
    type Member,
    MemberInput,
    buildMemberSchema,
} from "@/components/member-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { ROLES } from "@/components/role-selector";
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
    rolesRequired: string;
    duplicateAddress: string;
    accountId: {
        minLength: string;
        maxLength: string;
        charset: string;
        doesNotExist: string;
    };
}) {
    return z
        .object({
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
                    paymentThreshold: z.number().min(1).max(100),
                    governanceThreshold: z.number().min(1).max(100),
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
            members: buildMemberSchema({
                rolesRequired: messages.rolesRequired,
                duplicateAddress: messages.duplicateAddress,
                accountId: messages.accountId,
            }),
        })
        .refine((data) => {
            const financialMembers = data.members.filter((m) =>
                m.roles.includes("financial"),
            ).length;
            return data.details.paymentThreshold <= financialMembers;
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

function Step1({ handleNext, handleBack }: StepProps) {
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

function Threshold({
    title,
    description,
    value,
    onChange,
    max,
}: {
    title: string;
    description: string;
    value: number;
    onChange: (v: number) => void;
    max: number;
}) {
    const tCreate = useTranslations("createTreasury");
    const canDecrement = value > 1;
    const canIncrement = value < max;

    return (
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-4">
            <div className="flex flex-col flex-1 min-w-0">
                <h3 className="font-medium text-sm">{title}</h3>
                <p className="text-sm text-muted-foreground">{description}</p>
            </div>
            <div className="flex items-center gap-4 shrink-0 w-full sm:w-auto justify-start sm:justify-end">
                <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => onChange(value - 1)}
                    disabled={!canDecrement}
                    tooltipContent={
                        canDecrement ? undefined : tCreate("minimumVoteNote")
                    }
                >
                    <Minus className="size-4 text-secondary-foreground" />
                </Button>
                <span className="text-sm w-[21px] text-center">
                    {value}/{max}
                </span>
                <Button
                    type="button"
                    variant="secondary"
                    size="icon-sm"
                    onClick={() => onChange(value + 1)}
                    disabled={!canIncrement}
                    tooltipContent={
                        canIncrement ? undefined : tCreate("votingNote")
                    }
                >
                    <Plus className="size-4 text-secondary-foreground" />
                </Button>
            </div>
        </div>
    );
}

function Step2({ handleBack, handleNext }: StepProps) {
    const tCreate = useTranslations("createTreasury");
    const form = useFormContext<TreasuryFormValues>();
    const { accountId } = useNear();

    const handleContinue = async () => {
        const members = form.getValues("members");
        const memberFieldsToValidate = members.flatMap((_, index) => {
            if (index === 0 && !accountId) return [];
            return [
                `members.${index}.accountId`,
                `members.${index}.roles`,
            ] as const;
        });

        const isValid =
            memberFieldsToValidate.length > 0
                ? await form.trigger(memberFieldsToValidate as any)
                : true;

        if (!accountId) {
            form.clearErrors("members.0.accountId");
        }

        if (isValid && handleNext) {
            trackEvent("onboarding_step_completed", {
                step_name: "members",
                members_count: form.getValues("members").length,
            });
            handleNext();
        }
    };

    const { members } = form.watch();
    const financialMembers = members.filter((m: Member) =>
        m.roles.includes("financial"),
    ).length;
    const governanceMembers = members.filter((m: Member) =>
        m.roles.includes("governance"),
    ).length;

    useEffect(() => {
        const currentPayment = form.getValues("details.paymentThreshold");
        if (currentPayment > financialMembers) {
            form.setValue(
                "details.paymentThreshold",
                Math.max(1, financialMembers),
            );
        }
    }, [financialMembers]);

    useEffect(() => {
        const currentGovernance = form.getValues("details.governanceThreshold");
        if (currentGovernance > governanceMembers) {
            form.setValue(
                "details.governanceThreshold",
                Math.max(1, governanceMembers),
            );
        }
    }, [governanceMembers]);

    useEffect(() => {
        if (!accountId) {
            form.clearErrors("members.0.accountId");
        }
    }, [accountId, form]);

    return (
        <PageCard>
            <StepperHeader
                title={tCreate("addMembers")}
                handleBack={handleBack}
            />

            <InfoAlert message={tCreate("addMembersInfo")} />

            <div className="flex flex-col gap-8">
                <MemberInput
                    control={form.control}
                    mode="onboarding"
                    name={`members` as ArrayPath<TreasuryFormValues>}
                />
                <div className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                        <h3 className="font-semibold">
                            {tCreate("votingThreshold")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {tCreate("thresholdDescription")}
                        </p>
                    </div>

                    <div className="flex flex-col gap-4">
                        <FormField
                            control={form.control}
                            name="details.paymentThreshold"
                            render={({ field }) => (
                                <Threshold
                                    title={tCreate("financial")}
                                    description={tCreate(
                                        "financialDescription",
                                    )}
                                    value={field.value}
                                    onChange={field.onChange}
                                    max={financialMembers}
                                />
                            )}
                        />
                        <FormField
                            control={form.control}
                            name="details.governanceThreshold"
                            render={({ field }) => (
                                <Threshold
                                    title={tCreate("governance")}
                                    description={tCreate(
                                        "governanceDescription",
                                    )}
                                    value={field.value}
                                    onChange={field.onChange}
                                    max={governanceMembers}
                                />
                            )}
                        />
                    </div>
                </div>
                <InlineNextButton
                    text={tCreate("continue")}
                    onClick={handleContinue}
                />
            </div>
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

function Step3({ handleBack, handleNext }: StepProps) {
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

function Step4({
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
    const VISUAL = useMemo(
        () => [
            {
                icon: <UsersRound className="size-5 text-foreground" />,
                title: tCreate("membersLabel"),
            },
            {
                icon: <Vote className="size-5 text-foreground" />,
                title: tCreate("financialThreshold"),
            },
            {
                icon: <Vote className="size-5 text-foreground" />,
                title: tCreate("governanceThreshold"),
            },
        ],
        [tCreate],
    );
    const form = useFormContext<TreasuryFormValues>();
    const { details } = form.watch();
    const { members } = form.watch();
    const { isConfidential } = form.watch();
    const [showWalletSelector, setShowWalletSelector] = useState(false);

    const financialMembers = members.filter((m: Member) =>
        m.roles.includes("financial"),
    ).length;
    const governanceMembers = members.filter((m: Member) =>
        m.roles.includes("governance"),
    ).length;
    const financialThreshold = details.paymentThreshold;
    const governanceThreshold = details.governanceThreshold;
    const financialThresholdVisual = `${financialThreshold}/${financialMembers}`;
    const governanceThresholdVisual = `${governanceThreshold}/${governanceMembers}`;
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
                <div className="grid md:grid-cols-3 grid-cols-1 gap-2">
                    {[
                        members.length,
                        financialThresholdVisual,
                        governanceThresholdVisual,
                    ].map((item, index) => (
                        <InputBlock invalid={false} key={index}>
                            <div className="flex flex-col px-3.5 py-3 gap-1 items-center justify-center max-md:flex-row max-md:gap-2 max-md:justify-start">
                                {VISUAL[index].icon}
                                <div className="flex flex-col items-center gap-0.5 max-md:flex-row max-md:items-baseline max-md:gap-1.5">
                                    <p className="font-semibold text-xl">
                                        {item}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {VISUAL[index].title}
                                    </p>
                                </div>
                            </div>
                        </InputBlock>
                    ))}
                </div>
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
                text={tCreate("createButton")}
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
    const tMember = useTranslations("memberInput.validation");
    const tAccountId = useTranslations("accountIdInput");
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
            tStepTitles("members"),
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
                rolesRequired: tMember("rolesRequired"),
                duplicateAddress: tMember("duplicateAddress"),
                accountId: {
                    minLength: tAccountId("minLength"),
                    maxLength: tAccountId("maxLength"),
                    charset: tAccountId("charset"),
                    doesNotExist: tAccountId("doesNotExist"),
                },
            }),
        [tValidation, tMember, tAccountId],
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
                paymentThreshold: 1,
                governanceThreshold: 1,
                treasuryName: "",
                accountName: "",
            },
            isConfidential: false,
            members: [
                {
                    accountId: "",
                    roles: ROLES.map((r) => r.id),
                },
            ],
        },
    });
    useEffect(() => {
        if (accountId) {
            form.setValue("members.0.accountId", accountId);
        }
    }, [accountId]);

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

        const governors = data.members
            .filter((m) => m.roles.includes("governance"))
            .map((m) => m.accountId);
        const financiers = data.members
            .filter((m) => m.roles.includes("financial"))
            .map((m) => m.accountId);
        const requestors = data.members
            .filter((m) => m.roles.includes("requestor"))
            .map((m) => m.accountId);

        const request: CreateTreasuryRequest = {
            name: data.details.treasuryName,
            accountId: `${data.details.accountName}.sputnik-dao.near`,
            paymentThreshold: data.details.paymentThreshold,
            governanceThreshold: data.details.governanceThreshold,
            governors,
            isConfidential: data.isConfidential,
            financiers,
            requestors,
        };

        const initialSteps = request.isConfidential
            ? CONFIDENTIAL_STEPS
            : NON_CONFIDENTIAL_STEPS;

        setProgressSteps(initialSteps.map((s) => ({ ...s })));
        setProgressError(null);
        setCreatedTreasuryId(null);
        setProgressOpen(true);

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
                                { component: Step1 },
                                { component: Step2 },
                                { component: Step3 },
                                {
                                    component: Step4,
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
