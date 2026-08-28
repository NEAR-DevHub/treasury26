"use client";

import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    Coins01Icon,
    LoaderCircleIcon,
    LogoutSquare01Icon,
    CheckIcon,
    User03Icon,
} from "@hugeicons/core-free-icons";
import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import z from "zod";
import { APP_ACTIVE_TREASURY, LANDING_PAGE } from "@/constants/config";
import { Button } from "@/components/button";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import {
    CreationProgressModal,
    type CreationStep,
} from "@/components/creation-progress-modal";
import { LargeInput } from "@/components/large-input";
import { LoadingScreen } from "@/components/loading-screen";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import Logo from "@/components/icons/logo";
import { NearBusinessLogo } from "@/components/icons/near-business-logo";
import { Form, FormField, FormMessage } from "@/components/ui/form";
import { useProfile } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { useWarnings } from "@/hooks/use-warnings";
import {
    type CreateTreasuryRequest,
    checkHandleUnused,
    createTreasuryStream,
    submitWhitelistRequest,
} from "@/lib/api";
import { trackEvent } from "@/lib/analytics";
import { sanitizeReturnTo } from "@/lib/auth-redirect";
import { resolvePreferredMemberTreasuryId } from "@/lib/treasury-home";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

const ACCOUNT_SUFFIX = ".sputnik-dao.near";

// After a resumable failure, the backend sweeper finishes the treasury in the
// background. We re-drive the idempotent creation flow a few times so the user
// lands in their treasury within this session instead of seeing an error.
const CREATION_RECOVERY_MAX_ATTEMPTS = 12;
const CREATION_RECOVERY_DELAY_MS = 5000;

// Errors that will never succeed on retry (name taken, creation switched off).
// Everything else is treated as transient/resumable.
function isPermanentCreationError(message?: string): boolean {
    if (!message) return false;
    const normalized = message.toLowerCase();
    return (
        normalized.includes("already taken") ||
        normalized.includes("creation disabled")
    );
}

type InitialScreen = "create" | "login";
type LoginScreenSource = "sign-in" | "connect-wallet";
type FormValues = {
    treasuryName: string;
};

/**
 * The treasury handle is no longer entered by hand — it's derived from the
 * display name, so "Space X!" becomes `space-x.sputnik-dao.near`.
 */
function toAccountHandle(treasuryName: string): string {
    return treasuryName
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 64);
}

const ACCOUNT_ID_MAX_DISPLAY_LENGTH = 24;

/** Long account ids collapse to `abcdef...uvwxyz` so they never wrap or truncate mid-word. */
function shortenAccountId(accountId: string) {
    if (accountId.length < ACCOUNT_ID_MAX_DISPLAY_LENGTH) return accountId;

    return `${accountId.slice(0, 6)}...${accountId.slice(-6)}`;
}

/** The connected wallet, pinned to the bottom of the onboarding column. */
function ConnectedAccountCard({ accountId }: { accountId: string }) {
    const t = useTranslations("signIn");
    const { data: profile } = useProfile(accountId);
    const { disconnect } = useNear();
    const displayName = profile?.name;
    const shortAccountId = shortenAccountId(accountId);

    return (
        <div className="flex items-center gap-2 rounded-2xl border border-general-border bg-card px-4 py-3">
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-sm bg-green-700">
                    <Icon
                        icon={User03Icon}
                        className="size-4.5 text-white"
                        fill="currentColor"
                    />
                </span>
                <div className="flex min-w-0 flex-col text-sm leading-normal">
                    <span className="truncate font-semibold text-general-foreground">
                        {displayName ?? shortAccountId}
                    </span>
                    {displayName && (
                        <span className="truncate text-general-muted-foreground">
                            {shortAccountId}
                        </span>
                    )}
                </div>
            </div>
            <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="rounded-md text-general-unofficial-ghost-foreground"
                aria-label={t("disconnect")}
                onClick={() => disconnect()}
            >
                <Icon icon={LogoutSquare01Icon} />
            </Button>
        </div>
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

function AlreadyHaveTreasurySignIn({ onSignIn }: { onSignIn: () => void }) {
    const t = useTranslations("createTreasury");

    return (
        <p className="text-center text-sm">
            {t("alreadyHaveTreasuryLabel")}{" "}
            <Button
                type="button"
                variant="unstyled"
                className="h-auto p-0 underline"
                onClick={onSignIn}
            >
                {t("signInLabel")}
            </Button>
        </p>
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
    const tCommon = useTranslations("common");
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
    const { isLoading, lastTreasuryId, memberTreasuries } = useTreasury();
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

    const preferredTreasuryId = resolvePreferredMemberTreasuryId(
        memberTreasuries,
        lastTreasuryId,
    );
    const returnTo = sanitizeReturnTo(searchParams.get("returnTo"));
    const shouldKeepUserOnCreatePage = !!returnTo || forceStayOnCreatePage;
    // Reached from inside the app, the screen is a self-contained detour: it
    // drops the branding and account chrome and centres the form in the
    // viewport, with its own way back to the page that sent the user here.
    const isReturnToFlow = !!returnTo;
    const isCreateRoute = pathname === "/create";
    const isRootSignInScreen = pathname === "/" && showLoginScreen;
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
                id: "bulk_payment_setup",
                label: tSteps("provisioningBulkPayment"),
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
                    .max(64, tValidation("nameMax"))
                    // The handle is derived, so a name made only of symbols
                    // ("!!!") would leave nothing to build an account id from.
                    .refine(
                        (name) => toAccountHandle(name).length >= 2,
                        tValidation("nameInvalid"),
                    ),
            }),
        [tValidation],
    );

    const form = useForm<FormValues>({
        resolver: zodResolver(formSchema),
        defaultValues: {
            treasuryName: "",
        },
    });
    const treasuryName = form.watch("treasuryName");
    const isSubmitDisabled =
        isAuthenticating || isCheckingHandle || !treasuryName.trim();

    useEffect(() => {
        if (!accountId) return;
        setShowLoginScreen(false);
        if (pendingAutoCreateRef.current) {
            pendingAutoCreateRef.current = false;
            form.handleSubmit(onSubmit)();
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [accountId]);

    // Both failure modes land on the name field — it's the only input left.
    const isHandleAvailable = async (accountHandle: string) => {
        setIsCheckingHandle(true);
        try {
            const result = await checkHandleUnused(
                `${accountHandle}${ACCOUNT_SUFFIX}`,
            );
            if (result === null) {
                toast.error(t("creationFailed"));
                return false;
            }
            if (!result.unused) {
                form.setError("treasuryName", {
                    message: tValidation("nameTaken"),
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

        const accountHandle = toAccountHandle(values.treasuryName);
        if (!(await isHandleAvailable(accountHandle))) return;

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
            accountId: `${accountHandle}${ACCOUNT_SUFFIX}`,
            paymentThreshold: 1,
            governanceThreshold: 1,
            governors: [accountId],
            // This entry point only creates confidential treasuries.
            isConfidential: true,
            financiers: [accountId],
            requestors: [accountId],
        };

        setProgressSteps(CONFIDENTIAL_STEPS.map((step) => ({ ...step })));
        setProgressError(null);
        setCreatedTreasuryId(null);
        setShowWaitlist(false);
        setProgressOpen(true);

        const finishWithTreasury = (treasuryId: string) => {
            setProgressSteps((prev) =>
                prev.map((step) => ({ ...step, status: "completed" })),
            );
            setCreatedTreasuryId(treasuryId);
            trackEvent("treasury-created", { treasury_id: treasuryId });
            trackEvent("onboarding-completed", { treasury_id: treasuryId });
            queryClient.invalidateQueries({
                queryKey: ["userTreasuries", accountId],
            });
            router.push(`/${treasuryId}`);
        };

        // Drive a single create-stream attempt. The backend flow is idempotent,
        // so this can be safely re-driven to resume a half-finished creation.
        //
        // `trackProgress` maps per-step events onto the modal. We only do this
        // for the first (live) attempt; during recovery the re-drives replay
        // earlier steps and skip already-done ones, which would make the UI jump
        // around — so there we ignore step events and hold a single spinner
        // (see `showLoaderOnCurrentStep`) until it's actually done.
        const attemptStream = async (
            trackProgress: boolean,
        ): Promise<
            | { done: true; treasuryId: string }
            | { done: false; message?: string }
        > => {
            let outcome:
                | { done: true; treasuryId: string }
                | { done: false; message?: string } = { done: false };
            await createTreasuryStream(request, (event) => {
                if (event.step === "done") {
                    outcome = { done: true, treasuryId: event.treasury! };
                    return;
                }
                if (event.step === "error") {
                    outcome = { done: false, message: event.message };
                    return;
                }
                if (!trackProgress) return;
                setProgressSteps((prev) =>
                    prev.map((step) => {
                        if (step.id !== event.step) return step;
                        // Backend emits `failed` for non-fatal step failures
                        // (e.g. bulk-payment provisioning) that shouldn't abort
                        // the whole flow but still want to surface visually.
                        const status = (
                            event.status === "failed" ? "error" : event.status
                        ) as CreationStep["status"];
                        return { ...step, status };
                    }),
                );
            });
            return outcome;
        };

        // Show the spinner on the step where it stalled (the first one that
        // hasn't completed), so the modal never looks frozen while we recover.
        const showLoaderOnCurrentStep = () => {
            setProgressSteps((prev) => {
                const idx = prev.findIndex(
                    (step) => step.status !== "completed",
                );
                if (idx === -1) return prev;
                return prev.map((step, i) =>
                    i === idx ? { ...step, status: "in_progress" } : step,
                );
            });
        };

        // Keep the progress modal open and re-drive the flow until the backend
        // (this call or the background sweeper) finishes the treasury, then send
        // the user straight into it. Returns false if it never completes in time.
        const recoverInSession = async (): Promise<boolean> => {
            showLoaderOnCurrentStep();
            for (
                let attempt = 0;
                attempt < CREATION_RECOVERY_MAX_ATTEMPTS;
                attempt++
            ) {
                await new Promise((resolve) =>
                    setTimeout(resolve, CREATION_RECOVERY_DELAY_MS),
                );
                try {
                    const result = await attemptStream(false);
                    if (result.done) {
                        finishWithTreasury(result.treasuryId);
                        return true;
                    }
                    if (isPermanentCreationError(result.message)) {
                        return false;
                    }
                } catch {
                    // Transient network blip — keep trying until the window ends.
                }
                // Re-assert the spinner in case that attempt left the steps
                // static (e.g. the backend was busy and streamed nothing).
                showLoaderOnCurrentStep();
            }
            return false;
        };

        try {
            const first = await attemptStream(true);
            if (first.done) {
                finishWithTreasury(first.treasuryId);
                return;
            }
            // A permanent error can't be resumed; otherwise the sweeper is
            // already finishing it, so try to land the user in it this session.
            if (
                isPermanentCreationError(first.message) ||
                !(await recoverInSession())
            ) {
                setProgressOpen(false);
                setShowWaitlist(true);
            }
        } catch {
            if (!(await recoverInSession())) {
                setProgressOpen(false);
                setShowWaitlist(true);
            }
        }
    };

    const headerLogo = !isReturnToFlow ? (
        <Link href={LANDING_PAGE} aria-label="Near Business home">
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

    const openSignIn = () => {
        setForceStayOnCreatePage(false);
        setLoginScreenSource("sign-in");
        setShowLoginScreen(true);
    };

    const createFormBody = (
        <div
            className={cn(
                "mx-auto flex w-full max-w-[448px] flex-1 flex-col gap-5 pt-3",
                isReturnToFlow && "justify-center gap-6 pt-0",
            )}
        >
            <div className="flex flex-col gap-[42px]">
                {!isReturnToFlow && (
                    <NearBusinessLogo className="h-7 w-auto self-start" />
                )}
                <div className="flex flex-col gap-2">
                    <h1 className="text-2xl leading-[1.2] font-bold text-general-foreground">
                        {tPages("title")}
                    </h1>
                    <p className="text-sm leading-normal font-medium text-muted-foreground">
                        {t("subtitle")}
                    </p>
                </div>
            </div>

            <Form {...form}>
                <form
                    onSubmit={form.handleSubmit(onSubmit)}
                    className="flex flex-col gap-4"
                >
                    <FormField
                        control={form.control}
                        name="treasuryName"
                        render={({ field, fieldState }) => (
                            <div className="flex flex-col gap-1">
                                <label
                                    className={cn(
                                        "group flex h-16 items-center gap-3 rounded-3xl border bg-card py-2 pr-4 pl-3 transition-colors",
                                        fieldState.error
                                            ? "border-destructive"
                                            : "border-general-border focus-within:border-general-unofficial-border-4",
                                    )}
                                >
                                    <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-green-700">
                                        <Icon
                                            icon={Coins01Icon}
                                            className="size-4.5 text-white"
                                        />
                                    </span>
                                    <input
                                        {...field}
                                        // The design has no visible label, so
                                        // the placeholder doubles as one.
                                        aria-label={t("namePlaceholder")}
                                        autoComplete="off"
                                        maxLength={64}
                                        placeholder={t("namePlaceholder")}
                                        className="min-w-0 flex-1 bg-transparent text-xl leading-[1.2] font-semibold tracking-[-0.02em] text-general-foreground outline-none placeholder:text-general-muted-foreground"
                                        onChange={(e) => {
                                            field.onChange(e);
                                            form.clearErrors("treasuryName");
                                        }}
                                    />
                                    {field.value && (
                                        <button
                                            type="button"
                                            aria-label={t("clearName")}
                                            // Only offered while typing, and
                                            // mousedown is swallowed so the
                                            // blur doesn't hide us mid-click.
                                            className="hidden size-5 shrink-0 items-center justify-center text-general-muted-foreground group-focus-within:flex"
                                            onMouseDown={(e) =>
                                                e.preventDefault()
                                            }
                                            onClick={() => {
                                                field.onChange("");
                                                form.clearErrors(
                                                    "treasuryName",
                                                );
                                            }}
                                        >
                                            <Icon
                                                icon={Cancel01Icon}
                                                className="size-5"
                                            />
                                        </button>
                                    )}
                                </label>
                                <FormMessage />
                            </div>
                        )}
                    />

                    <Button
                        type="submit"
                        size="xl"
                        className="w-full rounded-2xl disabled:bg-general-unofficial-border-3 disabled:text-general-muted-foreground disabled:opacity-100"
                        disabled={isSubmitDisabled}
                    >
                        {(isAuthenticating || isCheckingHandle) && (
                            <Icon
                                icon={LoaderCircleIcon}
                                className="animate-spin"
                            />
                        )}
                        {accountId ? t("createCta") : t("continueToWallet")}
                    </Button>

                    {isReturnToFlow && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="xl"
                            className="w-full rounded-2xl text-general-unofficial-ghost-foreground"
                            onClick={() => router.push(returnTo)}
                        >
                            {tCommon("back")}
                        </Button>
                    )}
                </form>
            </Form>

            {!isReturnToFlow && (
                <div className="flex flex-1 flex-col justify-end">
                    {accountId ? (
                        <ConnectedAccountCard accountId={accountId} />
                    ) : (
                        <AlreadyHaveTreasurySignIn onSignIn={openSignIn} />
                    )}
                </div>
            )}
        </div>
    );

    const loginScreenBody = (
        <div className="mx-auto w-full max-w-[448px] space-y-3 md:mt-3">
            <ConnectWalletSelector
                source={isCreateRoute ? "/create" : "/"}
                connectFlow={isCreateRoute ? "onboarding" : "within_treasury"}
                isConnectingWallet={isAuthenticating}
                showBackButton={isConnectWalletLogin}
                showOnboardingHints={isConnectWalletLogin}
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
                                        <Icon
                                            icon={LoaderCircleIcon}
                                            className="animate-spin"
                                        />
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
                                <Icon
                                    icon={CheckIcon}
                                    className="text-general-success-foreground"
                                />
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
            {!accountId && <AlreadyHaveTreasurySignIn onSignIn={openSignIn} />}
        </div>
    );

    const screenBody = showLoginScreen
        ? loginScreenBody
        : showWaitlist || isTreasuryCreationBlocked
          ? waitlistBody
          : createFormBody;
    // The create form and the root sign-in screen bring their own logo and
    // heading, so the app header collapses to an empty bar above them.
    const isCreateScreen = screenBody === createFormBody;
    const isMinimalChrome = isRootSignInScreen || isCreateScreen;
    // The `returnTo` create screen carries its own Back button, so the header
    // has nothing left to render and the form can centre in the full viewport.
    const isCenteredCreateScreen = isCreateScreen && isReturnToFlow;

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
                description={accountId ? t("headerDescription") : undefined}
                backButton={isCenteredCreateScreen ? false : returnTo || false}
                hideCollapseButton
                hideLogin={!accountId}
                hideAppWarningBanner
                transparentHeader
                hideHeaderBottomBorder
                hideHeaderContent={isMinimalChrome}
                hideHeader={isCenteredCreateScreen}
                // Both onboarding screens are pinned to the viewport, and
                // scroll inside it only when a short one can't fit them.
                fitViewport={isMinimalChrome}
                logo={headerLogo}
                mainClassName={cn(
                    "pt-1",
                    isMinimalChrome && "flex flex-col bg-general-bg-tertiary",
                    // The screen fills the viewport, so the account card sits
                    // 32px off a phone's bottom edge; on desktop it keeps 24px
                    // instead of the 32px the shell uses for scrolling pages.
                    isCreateScreen &&
                        !isCenteredCreateScreen &&
                        "max-md:pb-8 md:pb-6",
                    // Centred in the viewport, the screen owns its spacing.
                    isCenteredCreateScreen && "py-0 md:py-0",
                )}
            >
                {screenBody}
            </PageComponentLayout>
        </>
    );
}
