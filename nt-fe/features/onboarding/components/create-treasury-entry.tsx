"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Gift, Globe, Loader2, Shield } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { APP_ACTIVE_TREASURY, LANDING_PAGE } from "@/constants/config";
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
import { useWarnings } from "@/hooks/use-warnings";
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
type InitialScreen = "create" | "login";
type LoginScreenSource = "sign-in" | "connect-wallet";
type FormValues = {
    treasuryName: string;
    accountName: string;
    isConfidential: boolean | null;
};

function sanitizeReturnTo(raw: string | null): string | null {
    if (!raw) return null;
    if (!raw.startsWith("/")) return null;
    return raw;
}

function TreasuryTypeOption({
    icon,
    title,
    description,
    selected,
    onClick,
}: {
    icon: ReactNode;
    title: string;
    description: string;
    selected: boolean;
    onClick: () => void;
}) {
    return (
        <button
            type="button"
            className={cn(
                "h-full rounded-xl border border-general-border p-3 md:p-4 text-left transition hover:bg-muted/70",
                selected ? "bg-general-tertiary " : "",
            )}
            onClick={onClick}
        >
            <div className="flex h-full items-start justify-between gap-3">
                <div className="space-y-1">
                    <div className="flex items-center gap-2">
                        {icon}
                        <p className="text-sm font-semibold">{title}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                        {description}
                    </p>
                </div>
                <div className="self-start size-5 min-h-5 min-w-5 shrink-0 rounded-full border-2 border-general-unofficial-border-3 flex items-center justify-center">
                    {selected && (
                        <div className="size-2.5 rounded-full bg-foreground" />
                    )}
                </div>
            </div>
        </button>
    );
}

function WaitlistInner({
    gapClassName,
    children,
}: {
    gapClassName: string;
    children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "mx-auto flex w-full max-w-[580px] flex-col items-center justify-center px-4 sm:px-8 md:px-12 lg:px-[60px]",
                gapClassName,
            )}
        >
            {children}
        </div>
    );
}

function WaitlistActionButton({
    className,
    ...props
}: React.ComponentProps<typeof Button>) {
    return (
        <Button
            className={cn(
                "min-h-9 w-full rounded-lg px-4 py-2 text-sm leading-5 tracking-normal",
                className,
            )}
            {...props}
        />
    );
}

export function TreasuryOnboardingPage({
    initialScreen = "create",
}: {
    initialScreen?: InitialScreen;
}) {
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const queryClient = useQueryClient();
    const t = useTranslations("createTreasury");
    const tValidation = useTranslations("createTreasury.validation");
    const tSteps = useTranslations("createTreasury.steps");
    const tPages = useTranslations("pages.createTreasury");
    const tLanding = useTranslations("landing");
    const { getWarning, isLoading: isLoadingWarnings } = useWarnings();
    const treasuryCreationWarning = getWarning("treasury-creation");
    const isTreasuryCreationBlocked =
        treasuryCreationWarning?.response === "paused";
    const {
        accountId,
        connect,
        isInitializing,
        isAuthenticating,
        authError,
        clearError,
    } = useNear();
    const { treasuries, isLoading, lastTreasuryId } = useTreasury();
    const [accountNameEdited, setAccountNameEdited] = useState(false);
    const [isCheckingHandle, setIsCheckingHandle] = useState(false);
    const [progressOpen, setProgressOpen] = useState(false);
    const [progressSteps, setProgressSteps] = useState<CreationStep[]>([]);
    const [progressError, setProgressError] = useState<string | null>(null);
    const [createdTreasuryId, setCreatedTreasuryId] = useState<string | null>(
        null,
    );
    const [showLoginScreen, setShowLoginScreen] = useState(
        initialScreen === "login",
    );
    const [loginScreenSource, setLoginScreenSource] =
        useState<LoginScreenSource>("sign-in");
    const [forceStayOnCreatePage, setForceStayOnCreatePage] = useState(false);
    const [waitlistContact, setWaitlistContact] = useState("");
    const [isSubmittingWaitlist, setIsSubmittingWaitlist] = useState(false);
    const [isWaitlistSubmitted, setIsWaitlistSubmitted] = useState(false);
    const [showWaitlist, setShowWaitlist] = useState(false);
    const pendingAutoCreateRef = useRef(false);
    const hasTrackedOnboardingEntry = useRef(false);
    const waitlistCardClassName =
        "mx-auto h-[516px] w-full max-w-[600px] items-center justify-center gap-5 overflow-hidden rounded-xl border border-border bg-card p-4";
    const waitlistSubtextClassName =
        "w-full text-center text-sm leading-5 tracking-normal text-muted-foreground";

    const preferredTreasuryId =
        (lastTreasuryId &&
            treasuries.some((treasury) => treasury.daoId === lastTreasuryId) &&
            lastTreasuryId) ||
        treasuries[0]?.daoId;
    const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
    const shouldKeepUserOnCreatePage = !!returnTo || forceStayOnCreatePage;
    const shouldShowHeaderLogo = !returnTo;
    const isCreateRoute = pathname === "/create";
    const isConnectWalletLogin = loginScreenSource === "connect-wallet";

    useEffect(() => {
        if (shouldKeepUserOnCreatePage) return;
        if (!accountId || isLoading) return;
        if (!preferredTreasuryId) {
            if (pathname === "/") {
                router.replace("/create");
            }
            return;
        }
        router.replace(`/${preferredTreasuryId}`);
    }, [
        accountId,
        isLoading,
        pathname,
        preferredTreasuryId,
        router,
        shouldKeepUserOnCreatePage,
    ]);

    useEffect(() => {
        if (isInitializing || isLoading || hasTrackedOnboardingEntry.current) {
            return;
        }

        hasTrackedOnboardingEntry.current = true;

        if (!shouldKeepUserOnCreatePage && accountId && preferredTreasuryId) {
            trackEvent("onboarding_existing_treasury_redirect", {
                entry_page: pathname,
                treasury_id: preferredTreasuryId,
            });
            return;
        }

        trackEvent("onboarding_landed", {
            page: pathname,
            is_authenticated: !!accountId,
        });
    }, [
        accountId,
        isInitializing,
        isLoading,
        pathname,
        preferredTreasuryId,
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
        if (!accountId) return;
        setShowLoginScreen(false);
        if (pendingAutoCreateRef.current) {
            pendingAutoCreateRef.current = false;
            form.handleSubmit(onSubmit)();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
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
            pendingAutoCreateRef.current = true;
            setForceStayOnCreatePage(true);
            setLoginScreenSource("connect-wallet");
            setShowLoginScreen(true);
            return;
        }

        if (isTreasuryCreationBlocked) {
            setShowWaitlist(true);
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
        setShowWaitlist(false);
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
                        treasury_id: treasuryId,
                    });
                    trackEvent("onboarding-completed", {
                        treasury_id: treasuryId,
                    });
                    queryClient.invalidateQueries({
                        queryKey: ["userTreasuries", accountId],
                    });
                    router.push(`/${treasuryId}`);
                    return;
                }

                if (event.step === "error") {
                    setProgressOpen(false);
                    setShowWaitlist(true);
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
            setProgressOpen(false);
            setShowWaitlist(true);
        }
    };

    const headerLogo = shouldShowHeaderLogo ? (
        <Link href={LANDING_PAGE} aria-label="Trezu home">
            <Logo size="md" />
        </Link>
    ) : undefined;

    if (isInitializing || isLoadingWarnings) {
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
            <div className="mx-auto w-full max-w-[600px] space-y-3 md:mt-10">
                <PageCard className="">
                    <Form {...form}>
                        <form
                            onSubmit={form.handleSubmit(onSubmit)}
                            className="space-y-4"
                        >
                            {!accountId && (
                                <h1 className="text-base font-semibold mb-1 md:mb-3">
                                    {tPages("title")}
                                </h1>
                            )}
                            <div className="space-y-2">
                                <p className="text-sm text-muted-foreground">
                                    {t("selectTreasuryTypeLabel")}
                                </p>

                                <div className="grid gap-3 md:grid-cols-2">
                                    <TreasuryTypeOption
                                        icon={
                                            <Globe className="size-4 text-foreground" />
                                        }
                                        title={t("public")}
                                        description={t("publicCardDescription")}
                                        selected={isConfidential === false}
                                        onClick={() =>
                                            form.setValue(
                                                "isConfidential",
                                                false,
                                            )
                                        }
                                    />
                                    <TreasuryTypeOption
                                        icon={
                                            <Shield
                                                className="size-4 text-foreground"
                                                fill="currentColor"
                                            />
                                        }
                                        title={t("confidential")}
                                        description={t(
                                            "confidentialCardDescription",
                                        )}
                                        selected={isConfidential === true}
                                        onClick={() =>
                                            form.setValue(
                                                "isConfidential",
                                                true,
                                            )
                                        }
                                    />
                                </div>
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
                                            suffixClassName="text-muted-foreground/60 text-sm!"
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

                            <Alert variant="info" className="block">
                                <AlertDescription>
                                    <div className="flex items-center gap-2">
                                        <Gift className="size-5 shrink-0" />
                                        <p className="text-sm font-semibold">
                                            {t("setupOnUsTitle")}
                                        </p>
                                    </div>
                                    <p className="text-xs md:pl-7">
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
                            onClick={() => {
                                setForceStayOnCreatePage(false);
                                setLoginScreenSource("sign-in");
                                setShowLoginScreen(true);
                            }}
                        >
                            {t("signInLabel")}
                        </Button>
                    </p>
                )}
            </div>
        </>
    );

    const loginScreenBody = (
        <div className="mx-auto w-full max-w-[600px] space-y-3 md:mt-8">
            <ConnectWalletSelector
                source={isCreateRoute ? "/create" : "/"}
                connectFlow={isCreateRoute ? "onboarding" : "within_treasury"}
                isConnectingWallet={isAuthenticating}
                showBackButton={isConnectWalletLogin}
                showOnboardingHints={isConnectWalletLogin}
                showCreateTreasuryCta={!isConnectWalletLogin}
                onCreateTreasuryClick={
                    isCreateRoute
                        ? () => {
                              setShowLoginScreen(false);
                              setForceStayOnCreatePage(true);
                          }
                        : undefined
                }
                onBack={
                    isConnectWalletLogin
                        ? () => {
                              if (returnTo) {
                                  router.push(returnTo);
                                  return;
                              }
                              setShowLoginScreen(false);
                          }
                        : undefined
                }
                onConnectSupported={async (walletId?: string) => {
                    if (authError) clearError();
                    await connect(walletId, isCreateRoute ? "/create" : "/");
                }}
            />
        </div>
    );

    const waitlistBody = (
        <div className="mx-auto mt-6 w-full max-w-[600px] space-y-3 md:mt-10">
            <PageCard className={waitlistCardClassName}>
                {!isWaitlistSubmitted ? (
                    <WaitlistInner gapClassName="gap-8">
                        <div className="flex w-full flex-col items-center justify-center gap-2">
                            <h1 className="w-full text-center text-2xl leading-7 font-semibold text-foreground">
                                {tLanding("waitlistTitle")}
                            </h1>
                            <div className="flex w-full flex-col items-center gap-1">
                                <p className={waitlistSubtextClassName}>
                                    {tLanding("waitlistDescription")}
                                </p>
                            </div>
                        </div>

                        <div className="flex w-full flex-col gap-5">
                            <div className="flex w-full flex-col gap-1">
                                <LargeInput
                                    value={waitlistContact}
                                    onChange={(e) =>
                                        setWaitlistContact(e.target.value)
                                    }
                                    placeholder={tLanding(
                                        "waitlistInputPlaceholder",
                                    )}
                                    borderless
                                    className="h-9 rounded-lg border-none bg-muted px-3 py-2 text-sm! leading-5 tracking-normal focus-visible:ring-0 focus-visible:ring-offset-0"
                                />
                                <p className="w-full text-xs leading-4 tracking-normal text-muted-foreground">
                                    {tLanding("waitlistPrivacyNote")}
                                </p>
                            </div>

                            <div className="flex w-full flex-col gap-3">
                                <WaitlistActionButton
                                    onClick={async () => {
                                        if (!waitlistContact.trim()) return;
                                        setIsSubmittingWaitlist(true);
                                        try {
                                            await submitWhitelistRequest({
                                                contact: waitlistContact.trim(),
                                                accountId:
                                                    accountId ?? undefined,
                                            });
                                            setIsWaitlistSubmitted(true);
                                        } catch {
                                            toast.error(
                                                tLanding(
                                                    "waitlistSubmitFailed",
                                                ),
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
                                </WaitlistActionButton>

                                <p className={waitlistSubtextClassName}>
                                    {tLanding("waitlistLookAroundFirst")}{" "}
                                    <Button
                                        type="button"
                                        variant="unstyled"
                                        className="h-auto p-0 text-sm font-normal leading-5 tracking-normal text-muted-foreground underline"
                                        onClick={() =>
                                            window.open(
                                                APP_ACTIVE_TREASURY,
                                                "_blank",
                                                "noopener,noreferrer",
                                            )
                                        }
                                    >
                                        {tLanding("waitlistSeeDemo")}
                                    </Button>
                                </p>
                            </div>
                        </div>
                    </WaitlistInner>
                ) : (
                    <WaitlistInner gapClassName="gap-6">
                        <div className="flex w-full flex-col items-center justify-center gap-2">
                            <div className="inline-flex size-9 items-center justify-center rounded-full bg-general-success-background-faded">
                                <Check className="size-5 text-general-success-foreground" />
                            </div>
                            <h1 className="w-full text-center text-2xl leading-7 font-semibold text-foreground">
                                {tLanding("waitlistSubmittedTitle")}
                            </h1>
                            <div className="flex w-full flex-col items-center gap-1">
                                <p className="w-full max-w-[310px] text-center text-sm leading-5 tracking-normal text-foreground">
                                    {tLanding("waitlistSubmittedDescription")}
                                </p>
                            </div>
                        </div>

                        <div className="flex w-full flex-col items-center gap-3">
                            <WaitlistActionButton
                                variant="secondary"
                                onClick={() => router.push(APP_ACTIVE_TREASURY)}
                            >
                                {tLanding("waitlistSeeDemo")}
                            </WaitlistActionButton>
                        </div>
                    </WaitlistInner>
                )}
            </PageCard>
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
                />
                <PageComponentLayout
                    title={tPages("title")}
                    description={t("headerDescription")}
                    backButton={returnTo || false}
                    hideCollapseButton
                    hideAppWarningBanner
                    transparentHeader
                    hideHeaderBottomBorder
                    logo={headerLogo}
                    mainClassName="pt-1"
                >
                    {showWaitlist || isTreasuryCreationBlocked
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
            backButton={returnTo || false}
            hideCollapseButton
            hideLogin
            hideAppWarningBanner
            transparentHeader
            hideHeaderBottomBorder
            logo={headerLogo}
            mainClassName="pt-1"
        >
            <CreationProgressModal
                open={progressOpen}
                steps={progressSteps}
                error={progressError}
                treasuryId={createdTreasuryId}
                onClose={() => setProgressOpen(false)}
            />
            {showWaitlist || isTreasuryCreationBlocked
                ? waitlistBody
                : showLoginScreen
                  ? loginScreenBody
                  : createFormBody}
        </PageComponentLayout>
    );
}
