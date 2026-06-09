"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Gift, Globe, Loader2, Shield } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { APP_ACTIVE_TREASURY } from "@/constants/config";
import { Alert, AlertDescription } from "@/components/alert";
import { Button } from "@/components/button";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import {
    CreationProgressModal,
    type CreationStep,
} from "@/components/creation-progress-modal";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import { LoadingScreen } from "@/components/loading-screen";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import Logo from "@/components/icons/logo";
import { Form, FormField, FormMessage } from "@/components/ui/form";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryCreationStatus } from "@/hooks/use-treasury-queries";
import {
    type CreateTreasuryRequest,
    checkHandleUnused,
    createTreasuryStream,
    submitWhitelistRequest,
} from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

const ACCOUNT_SUFFIX = ".sputnik-dao.near";
const CREATE_TREASURY_CONTEXT = "create_treasury";
type FormValues = {
    treasuryName: string;
    accountName: string;
    isConfidential: boolean | null;
};

export function CreateTreasuryEntry() {
    const router = useRouter();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const t = useTranslations("createTreasury");
    const tValidation = useTranslations("createTreasury.validation");
    const tSteps = useTranslations("createTreasury.steps");
    const tPages = useTranslations("pages.createTreasury");
    const tLanding = useTranslations("landing");
    const tCommon = useTranslations("common");
    const {
        accountId,
        connect,
        isInitializing,
        isAuthenticating,
        authError,
        clearError,
    } = useNear();
    const { treasuries, isLoading, lastTreasuryId } = useTreasury();
    const { data: creationStatus } = useTreasuryCreationStatus();

    const [accountNameEdited, setAccountNameEdited] = useState(false);
    const [isCheckingHandle, setIsCheckingHandle] = useState(false);
    const [progressOpen, setProgressOpen] = useState(false);
    const [progressSteps, setProgressSteps] = useState<CreationStep[]>([]);
    const [progressError, setProgressError] = useState<string | null>(null);
    const [createdTreasuryId, setCreatedTreasuryId] = useState<string | null>(
        null,
    );
    const [showLoginScreen, setShowLoginScreen] = useState(false);
    const [forceStayOnCreatePage, setForceStayOnCreatePage] = useState(false);
    const [waitlistContact, setWaitlistContact] = useState("");
    const [isSubmittingWaitlist, setIsSubmittingWaitlist] = useState(false);
    const [isWaitlistSubmitted, setIsWaitlistSubmitted] = useState(false);

    const preferredTreasuryId =
        (lastTreasuryId &&
            treasuries.some((treasury) => treasury.daoId === lastTreasuryId) &&
            lastTreasuryId) ||
        treasuries[0]?.daoId;
    const shouldStayOnCreatePage =
        searchParams.get("context") === CREATE_TREASURY_CONTEXT;
    const shouldKeepUserOnCreatePage =
        shouldStayOnCreatePage || forceStayOnCreatePage;
    const creationAvailable = creationStatus?.creationAvailable ?? true;
    const showWaitlist =
        !!accountId && !isLoading && !preferredTreasuryId && !creationAvailable;

    useEffect(() => {
        if (shouldKeepUserOnCreatePage) return;
        if (!accountId || isLoading) return;
        if (!preferredTreasuryId) return;
        router.replace(`/${preferredTreasuryId}`);
    }, [
        accountId,
        isLoading,
        preferredTreasuryId,
        router,
        shouldKeepUserOnCreatePage,
    ]);

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
    const formSchema = useMemo(
        () =>
            z.object({
                treasuryName: z
                    .string()
                    .min(2, tValidation("nameMin"))
                    .max(64, tValidation("nameMax")),
                accountName: z
                    .string()
                    .min(2, tValidation("accountMin"))
                    .max(64, tValidation("accountMax"))
                    .regex(/^[a-z0-9-]+$/, tValidation("accountChars")),
                isConfidential: z.boolean().nullable(),
            }),
        [tValidation],
    );

    const form = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            treasuryName: "",
            accountName: "",
            isConfidential: null,
        },
    });
    const isConfidential = form.watch("isConfidential");
    const treasuryName = form.watch("treasuryName");
    const isSubmitDisabled =
        isAuthenticating ||
        isCheckingHandle ||
        isConfidential === null ||
        !treasuryName.trim();

    useEffect(() => {
        if (!authError) return;
        toast.error(authError, { duration: 8000 });
    }, [authError]);

    useEffect(() => {
        if (!accountId) return;
        setShowLoginScreen(false);
    }, [accountId]);

    const validateAccountName = async (accountName: string) => {
        const fullAccountId = `${accountName}${ACCOUNT_SUFFIX}`;
        setIsCheckingHandle(true);
        try {
            const result = await checkHandleUnused(fullAccountId);
            if (!result?.unused) {
                form.setError("accountName", {
                    message: tValidation("accountTaken"),
                });
                return false;
            }
            return true;
        } finally {
            setIsCheckingHandle(false);
        }
    };

    const onSubmit = async (values: FormValues) => {
        if (!values.treasuryName.trim()) {
            form.setError("treasuryName", { message: tValidation("nameMin") });
            return;
        }

        const isAvailable = await validateAccountName(values.accountName);
        if (!isAvailable) return;

        if (values.isConfidential === null) {
            toast.error(t("selectTreasuryTypeError"));
            return;
        }

        if (!accountId) {
            setForceStayOnCreatePage(true);
            setShowLoginScreen(true);
            return;
        }

        const request: CreateTreasuryRequest = {
            name: values.treasuryName,
            accountId: `${values.accountName}${ACCOUNT_SUFFIX}`,
            paymentThreshold: 1,
            governanceThreshold: 1,
            governors: [accountId],
            isConfidential: values.isConfidential,
            financiers: [accountId],
            requestors: [accountId],
        };

        const initialSteps = request.isConfidential
            ? CONFIDENTIAL_STEPS
            : NON_CONFIDENTIAL_STEPS;
        setProgressSteps(initialSteps.map((step) => ({ ...step })));
        setProgressError(null);
        setCreatedTreasuryId(null);
        setProgressOpen(true);

        try {
            await createTreasuryStream(request, (event) => {
                if (event.step === "done") {
                    const treasuryId = event.treasury!;
                    setProgressSteps((prev) =>
                        prev.map((step) => ({
                            ...step,
                            status: "completed",
                        })),
                    );
                    setCreatedTreasuryId(treasuryId);
                    trackEvent("treasury-created", {
                        source: "/",
                        treasury_id: treasuryId,
                    });
                    trackEvent("onboarding-completed", {
                        source: "/",
                        treasury_id: treasuryId,
                    });
                    queryClient.invalidateQueries({
                        queryKey: ["userTreasuries", accountId],
                    });
                    return;
                }

                if (event.step === "error") {
                    setProgressSteps((prev) =>
                        prev.map((step) =>
                            step.status === "in_progress"
                                ? { ...step, status: "error" }
                                : step,
                        ),
                    );
                    setProgressError(event.message ?? t("unexpectedError"));
                    return;
                }

                setProgressSteps((prev) =>
                    prev.map((step) => {
                        if (step.id !== event.step) return step;
                        return {
                            ...step,
                            status: event.status as CreationStep["status"],
                        };
                    }),
                );
            });
        } catch {
            setProgressSteps((prev) =>
                prev.map((step) =>
                    step.status === "in_progress"
                        ? { ...step, status: "error" }
                        : step,
                ),
            );
            setProgressError(t("creationFailed"));
        }
    };

    const unauthHeaderLogo = <Logo size="sm" />;

    if (isInitializing) {
        return <LoadingScreen />;
    }

    if (
        accountId &&
        !shouldKeepUserOnCreatePage &&
        (isLoading || preferredTreasuryId)
    ) {
        return <LoadingScreen />;
    }

    const createFormBody = (
        <>
            <div className="mx-auto mt-6 w-full max-w-[668px] space-y-3 md:mt-10">
                <PageCard className="">
                    <Form {...form}>
                        <form
                            onSubmit={form.handleSubmit(onSubmit)}
                            className="space-y-4"
                        >
                            <h1 className="text-lg font-semibold mb-3">
                                {tPages("title")}
                            </h1>
                            <p className="text-md text-muted-foreground">
                                {t("selectTreasuryTypeLabel")}
                            </p>
                            <div className="grid gap-3 md:grid-cols-2">
                                <button
                                    type="button"
                                    className={cn(
                                        "rounded-xl border border-general-border p-4 text-left transition hover:bg-muted/70",
                                    )}
                                    onClick={() =>
                                        form.setValue("isConfidential", false)
                                    }
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                                <Globe
                                                    className={
                                                        "size-4 text-foreground"
                                                    }
                                                />
                                                <p className="font-semibold">
                                                    {t("public")}
                                                </p>
                                            </div>
                                            <p className="text-sm text-muted-foreground">
                                                {t("publicCardDescription")}
                                            </p>
                                        </div>
                                        <div
                                            className={cn(
                                                "mt-1 size-5 min-h-5 min-w-5 shrink-0 rounded-full border-2 border-general-unofficial-border-3 bg-[rgba(0,0,0,0.05)] flex items-center justify-center",
                                            )}
                                        >
                                            {isConfidential === false && (
                                                <div className="size-2.5 rounded-full bg-foreground" />
                                            )}
                                        </div>
                                    </div>
                                </button>

                                <button
                                    type="button"
                                    className={cn(
                                        "rounded-xl border border-general-border p-4 text-left transition hover:bg-muted/70",
                                    )}
                                    onClick={() =>
                                        form.setValue("isConfidential", true)
                                    }
                                >
                                    <div className="flex items-start justify-between gap-3">
                                        <div className="space-y-1">
                                            <div className="flex items-center gap-2">
                                                <Shield
                                                    className={
                                                        "size-4 text-foreground"
                                                    }
                                                    fill="currentColor"
                                                />
                                                <p className="font-semibold">
                                                    {t("confidential")}
                                                </p>
                                            </div>
                                            <p className="text-sm text-muted-foreground">
                                                {t(
                                                    "confidentialCardDescription",
                                                )}
                                            </p>
                                        </div>
                                        <div
                                            className={cn(
                                                "mt-1 size-5 min-h-5 min-w-5 shrink-0 rounded-full border-2 border-general-unofficial-border-3 bg-[rgba(0,0,0,0.05)] flex items-center justify-center",
                                            )}
                                        >
                                            {isConfidential === true && (
                                                <div className="size-2.5 rounded-full bg-foreground" />
                                            )}
                                        </div>
                                    </div>
                                </button>
                            </div>

                            <FormField
                                control={form.control}
                                name="treasuryName"
                                render={({ field, fieldState }) => (
                                    <InputBlock
                                        title={t("treasuryName")}
                                        invalid={!!fieldState.error}
                                        interactive
                                    >
                                        <LargeInput
                                            borderless
                                            className="text-lg!"
                                            placeholder={t(
                                                "treasuryNamePlaceholder",
                                            )}
                                            value={field.value}
                                            onChange={(e) => {
                                                field.onChange(e);
                                                form.clearErrors(
                                                    "treasuryName",
                                                );

                                                if (!accountNameEdited) {
                                                    const generated =
                                                        e.target.value
                                                            .toLowerCase()
                                                            .replace(
                                                                /[^a-z0-9-]/g,
                                                                "-",
                                                            )
                                                            .replace(/-+/g, "-")
                                                            .replace(
                                                                /^-|-$/g,
                                                                "",
                                                            )
                                                            .slice(0, 64);
                                                    form.setValue(
                                                        "accountName",
                                                        generated,
                                                    );
                                                    form.clearErrors(
                                                        "accountName",
                                                    );
                                                }
                                            }}
                                        />
                                        <FormMessage />
                                    </InputBlock>
                                )}
                            />

                            <FormField
                                control={form.control}
                                name="accountName"
                                render={({ field, fieldState }) => (
                                    <InputBlock
                                        title={t("accountName")}
                                        info={t("accountNameInfo")}
                                        invalid={!!fieldState.error}
                                        interactive
                                    >
                                        <LargeInput
                                            borderless
                                            textSizeClassName="text-lg!"
                                            placeholder={t(
                                                "accountPlaceholderUnderscore",
                                            )}
                                            suffix={ACCOUNT_SUFFIX}
                                            value={field.value}
                                            onChange={(e) => {
                                                setAccountNameEdited(true);
                                                const input = e.target.value
                                                    .toLowerCase()
                                                    .replace(/[^a-z0-9-]/g, "")
                                                    .slice(0, 64);
                                                field.onChange(input);
                                                form.clearErrors("accountName");
                                            }}
                                        />
                                        <FormMessage />
                                    </InputBlock>
                                )}
                            />

                            <Alert variant="info" className="items-start gap-3">
                                <Gift className="mt-0.5 size-5 shrink-0" />
                                <AlertDescription className="gap-0">
                                    <p className="text-sm font-semibold mb-0">
                                        {t("setupOnUsTitle")}
                                    </p>
                                    <p className="text-sm">
                                        {t("setupOnUsDescription")}
                                    </p>
                                </AlertDescription>
                            </Alert>

                            <Button
                                type="submit"
                                className="w-full"
                                disabled={isSubmitDisabled}
                            >
                                {(isAuthenticating || isCheckingHandle) && (
                                    <Loader2 className="size-4 animate-spin" />
                                )}
                                {accountId
                                    ? t("createButton")
                                    : t("continueToWallet")}
                            </Button>
                        </form>
                    </Form>
                </PageCard>
                {!accountId && (
                    <p className="text-center text-sm">
                        {t("alreadyHaveTreasuryLabel")}{" "}
                        <Button
                            type="button"
                            variant="unstyled"
                            className="h-auto p-0 underline"
                            onClick={() => setShowLoginScreen(true)}
                        >
                            {t("signInLabel")}
                        </Button>
                    </p>
                )}
            </div>
        </>
    );

    const loginScreenBody = (
        <div className="mx-auto mt-6 w-full max-w-[668px] md:mt-8">
            <ConnectWalletSelector
                source="/"
                connectFlow="onboarding"
                isConnectingWallet={isAuthenticating}
                onBack={() => setShowLoginScreen(false)}
                onConnectSupported={async (walletId?: string) => {
                    if (authError) clearError();
                    await connect(walletId);
                }}
            />
        </div>
    );

    const waitlistBody = (
        <div className="mx-auto mt-6 w-full max-w-[668px] space-y-3 md:mt-10">
            <PageCard className="py-20">
                <div className="mx-auto w-full max-w-[580px] space-y-6">
                    <div className="space-y-2">
                        <h1 className="text-center text-2xl font-semibold tracking-tight">
                            {isWaitlistSubmitted
                                ? tLanding("waitlistSubmittedTitle")
                                : tLanding("waitlistTitle")}
                        </h1>
                        <p className="mx-auto max-w-[560px] text-center text-sm text-muted-foreground">
                            {isWaitlistSubmitted
                                ? tLanding("waitlistSubmittedDescription")
                                : tLanding("waitlistDescription")}
                        </p>
                    </div>

                    {!isWaitlistSubmitted && (
                        <div className="space-y-5">
                            <div className="space-y-1">
                                <LargeInput
                                    value={waitlistContact}
                                    onChange={(e) =>
                                        setWaitlistContact(e.target.value)
                                    }
                                    placeholder={tLanding(
                                        "waitlistInputPlaceholder",
                                    )}
                                    borderless
                                    className="px-3 bg-muted border-none focus-visible:ring-0 text-sm!"
                                />
                                <p className="text-xs text-muted-foreground">
                                    {tLanding("waitlistPrivacyNote")}
                                </p>
                            </div>
                            <Button
                                className="w-full"
                                onClick={async () => {
                                    if (!waitlistContact.trim()) return;
                                    setIsSubmittingWaitlist(true);
                                    try {
                                        await submitWhitelistRequest({
                                            contact: waitlistContact.trim(),
                                            accountId: accountId ?? undefined,
                                        });
                                        setIsWaitlistSubmitted(true);
                                    } catch {
                                        toast.error(
                                            tLanding("waitlistSubmitFailed"),
                                        );
                                    } finally {
                                        setIsSubmittingWaitlist(false);
                                    }
                                }}
                                disabled={
                                    isSubmittingWaitlist ||
                                    !waitlistContact.trim()
                                }
                            >
                                {isSubmittingWaitlist && (
                                    <Loader2 className="size-4 animate-spin" />
                                )}
                                {tLanding("waitlistSubmit")}
                            </Button>
                        </div>
                    )}

                    <Button
                        variant={isWaitlistSubmitted ? "secondary" : "ghost"}
                        className="w-full"
                        onClick={() => router.push(APP_ACTIVE_TREASURY)}
                    >
                        {tCommon("seeDemo")}
                    </Button>
                </div>
            </PageCard>
            {!accountId && (
                <p className="text-center text-sm">
                    {t("alreadyHaveTreasuryLabel")}{" "}
                    <Button
                        type="button"
                        variant="unstyled"
                        className="h-auto p-0 underline"
                        onClick={() => setShowLoginScreen(true)}
                    >
                        {t("signInLabel")}
                    </Button>
                </p>
            )}
        </div>
    );

    if (accountId) {
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
                <PageComponentLayout
                    title={tPages("title")}
                    description={t("headerDescription")}
                    hideCollapseButton
                    hideSystemStatusBanner
                    transparentHeader
                >
                    {showWaitlist
                        ? waitlistBody
                        : showLoginScreen
                          ? loginScreenBody
                          : createFormBody}
                </PageComponentLayout>
            </>
        );
    }

    return (
        <PageComponentLayout
            title={tPages("title")}
            hideCollapseButton
            hideLogin
            hideSystemStatusBanner
            transparentHeader
            logo={unauthHeaderLogo}
        >
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
            {showWaitlist
                ? waitlistBody
                : showLoginScreen
                  ? loginScreenBody
                  : createFormBody}
        </PageComponentLayout>
    );
}
