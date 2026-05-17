"use client";

import { GradFlow } from "gradflow";
import { ArrowRight, Compass, Loader2, UserCheck } from "lucide-react";
import { motion } from "motion/react";
import Image from "next/image";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { AuthProvider } from "@/components/auth-provider";
import { Button } from "@/components/button";
import Logo from "@/components/icons/logo";
import { Input } from "@/components/input";
import { LanguageSwitcher } from "@/components/language-switcher";
import { LoadingScreen } from "@/components/loading-screen";
import { NearInitializer } from "@/components/near-initializer";
import { QueryProvider } from "@/components/query-provider";
import { APP_ACTIVE_TREASURY, LANDING_PAGE } from "@/constants/config";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryCreationStatus } from "@/hooks/use-treasury-queries";
import { trackEvent } from "@/lib/analytics";
import { submitWhitelistRequest } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { useOnboardingStore } from "@/stores/onboarding-store";

function FadeInUp({
    children,
    className,
    delay,
    y = 10,
    duration = 0.35,
}: {
    children: React.ReactNode;
    className?: string;
    delay: number;
    y?: number;
    duration?: number;
}) {
    return (
        <motion.div
            className={className}
            initial={{ opacity: 0, y }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration, ease: "easeOut", delay }}
        >
            {children}
        </motion.div>
    );
}

function WipeRevealText({
    children,
    className,
    delay,
    x,
    blur = 8,
    duration = 0.6,
}: {
    children: React.ReactNode;
    className: string;
    delay: number;
    x: number;
    blur?: number;
    duration?: number;
}) {
    return (
        <div className="overflow-hidden">
            <motion.p
                className={className}
                initial={{
                    clipPath: "inset(0 100% 0 0)",
                    x,
                    opacity: 0,
                    filter: `blur(${blur}px)`,
                }}
                animate={{
                    clipPath: "inset(0 0% 0 0)",
                    x: 0,
                    opacity: 1,
                    filter: "blur(0px)",
                }}
                transition={{ duration, ease: "easeOut", delay }}
            >
                {children}
            </motion.p>
        </div>
    );
}

function OnboardingChoiceCard({
    icon: Icon,
    title,
    description,
    active,
    disabled,
    onClick,
}: {
    icon: React.ComponentType<React.SVGProps<SVGSVGElement>>;
    title: string;
    description: string;
    active: boolean;
    disabled?: boolean;
    onClick: () => void;
}) {
    return (
        <Button
            type="button"
            onClick={onClick}
            disabled={disabled}
            className={cn(
                "group h-[246px] w-full max-w-[329px] rounded-xl border px-2 py-5 text-left transition-all duration-200 md:h-[320px] md:w-[320px] md:max-w-none md:p-6 lg:h-[360px] lg:w-[360px]",
                "flex flex-col items-center justify-center gap-3 shadow-none md:gap-8",
                active
                    ? "bg-onboarding-primary text-primary-foreground border-border hover:bg-onboarding-primary/95"
                    : "bg-secondary text-primary border-border hover:bg-secondary/85",
            )}
        >
            <Icon
                className={cn(
                    "size-7",
                    active ? "text-primary-foreground" : "text-primary",
                )}
            />
            <div className="space-y-1 text-center">
                <p className="text-2xl font-semibold">{title}</p>
                <p
                    className={cn(
                        "mx-auto text-center text-md whitespace-normal wrap-break-word",
                        active
                            ? "text-primary-foreground"
                            : "text-muted-foreground",
                    )}
                >
                    {description}
                </p>
            </div>
            <div
                className={cn(
                    "",
                    active ? "text-primary-foreground" : "text-primary",
                )}
            >
                {disabled ? (
                    <Loader2 className="size-4 animate-spin" />
                ) : (
                    <ArrowRight className="size-4" />
                )}
            </div>
        </Button>
    );
}

function GradientTitle() {
    const t = useTranslations("landing");
    return (
        <div className="overflow-hidden w-full py-1">
            <motion.p
                className="text-[30px] lg:text-5xl tracking-[-1%] leading-[28px] lg:leading-[48px] text-center lg:text-left w-full h-fit font-medium text-white backdrop-blur-[10px] mix-blend-overlay"
                initial={{
                    clipPath: "inset(0 100% 0 0)",
                    x: 0,
                    filter: "blur(8px)",
                    opacity: 1,
                }}
                animate={{
                    clipPath: "inset(0 0% 0 0)",
                    x: 0,
                    filter: "blur(0px)",
                    opacity: 1,
                }}
                transition={{ duration: 0.6, ease: "easeOut", delay: 0.2 }}
                style={{
                    WebkitMask: "linear-gradient(#000 0 0) text",
                    mask: "linear-gradient(#000 0 0) text",
                    mixBlendMode: "overlay",
                }}
            >
                {t("gradientTagline")}
            </motion.p>
        </div>
    );
}

function WhitelistExperience({
    contact,
    setContact,
    submitted,
    isSubmitting,
    onSubmit,
}: {
    contact: string;
    setContact: (value: string) => void;
    submitted: boolean;
    isSubmitting: boolean;
    onSubmit: () => void;
}) {
    const t = useTranslations("landing");
    const tCommon = useTranslations("common");
    return (
        <div className="relative h-screen w-full overflow-hidden">
            <div className="fixed top-3 right-3 z-50 md:top-6 md:right-6">
                <LanguageSwitcher variant="outline" />
            </div>
            <GradFlow
                config={{
                    color1: { r: 0, g: 67, b: 224 },
                    color2: { r: 255, g: 255, b: 255 },
                    color3: { r: 9, g: 83, b: 255 },
                    speed: 0.4,
                    scale: 1,
                    type: "stripe",
                    noise: 0.08,
                }}
                className="absolute inset-0"
            />
            <div className="flex relative w-full h-full items-center justify-between overflow-hidden">
                <div className="w-full lg:w-2/5 h-full p-2 lg:p-4 flex flex-col justify-center min-w-0">
                    <div className="w-full min-h-[30%] flex items-center lg:hidden">
                        <GradientTitle />
                    </div>
                    <motion.div
                        className="perspective-distant w-full gap-12 flex flex-col p-4 items-center h-full justify-center bg-white rounded-2xl lg:max-w-4xl"
                        initial={{
                            opacity: 0,
                            y: 44,
                            rotateX: 62,
                            scale: 0.96,
                        }}
                        animate={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
                        transition={{
                            duration: 0.7,
                            ease: [0.22, 1, 0.36, 1],
                            delay: 0.14,
                        }}
                        style={{ transformOrigin: "center bottom" }}
                    >
                        <Link href={LANDING_PAGE}>
                            <Logo size="lg" />
                        </Link>
                        <div className="flex w-full flex-col items-center justify-center gap-6">
                            <div className="flex w-full flex-col gap-2 text-center max-w-md">
                                <h1 className="text-2xl font-semibold">
                                    {submitted
                                        ? t("waitlistSubmittedTitle")
                                        : t("waitlistTitle")}
                                </h1>
                                {submitted ? (
                                    <p className="text-sm text-muted-foreground font-medium">
                                        {t("waitlistSubmittedDescription")}
                                    </p>
                                ) : (
                                    <p className="text-sm text-muted-foreground font-medium">
                                        {t("waitlistDescription")}
                                    </p>
                                )}
                            </div>
                            <div className="flex flex-col w-full px-4 lg:px-16 gap-3 items-center justify-center">
                                {submitted ? (
                                    <Button
                                        size="default"
                                        variant="secondary"
                                        asChild
                                        className="w-full max-w-md"
                                    >
                                        <Link href={APP_ACTIVE_TREASURY}>
                                            {tCommon("seeDemo")}
                                        </Link>
                                    </Button>
                                ) : (
                                    <div className="flex flex-col gap-3 w-full max-w-md">
                                        <div className="flex flex-col gap-2 items-start">
                                            <Input
                                                type="text"
                                                placeholder={t(
                                                    "waitlistInputPlaceholder",
                                                )}
                                                value={contact}
                                                onChange={(e) =>
                                                    setContact(e.target.value)
                                                }
                                            />
                                            <p className="text-xs text-muted-foreground -mt-1">
                                                {t("waitlistPrivacyNote")}
                                            </p>
                                        </div>
                                        <Button
                                            size="default"
                                            className="mt-2"
                                            onClick={onSubmit}
                                            disabled={
                                                isSubmitting || !contact.trim()
                                            }
                                        >
                                            {isSubmitting && (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            )}
                                            {t("waitlistSubmit")}
                                        </Button>
                                        <Button
                                            size="default"
                                            variant="ghost"
                                            asChild
                                        >
                                            <Link href={APP_ACTIVE_TREASURY}>
                                                {tCommon("seeDemo")}
                                            </Link>
                                        </Button>
                                    </div>
                                )}
                            </div>
                        </div>
                    </motion.div>
                </div>

                <div className="hidden h-fit my-auto lg:flex w-3/5 pt-12 pb-7 pl-16 flex-col gap-9">
                    <div className="w-full pr-[72px]">
                        <GradientTitle />
                    </div>
                    <motion.div
                        className="relative w-full h-fit rounded-[16px] rounded-r-none overflow-hidden min-h-[360px]"
                        initial={{ opacity: 0, x: 48, scale: 0.97 }}
                        animate={{ opacity: 1, x: 0, scale: 1 }}
                        transition={{
                            duration: 0.75,
                            ease: [0.22, 1, 0.36, 1],
                            delay: 0.5,
                        }}
                        style={{ transformOrigin: "center bottom" }}
                    >
                        <Image
                            src="/welcome.svg"
                            loading="eager"
                            alt={t("welcomeAlt")}
                            priority
                            width={1000}
                            height={500}
                            className="h-full rounded-l-[16px] w-auto min-w-[calc(100%+200px)]"
                        />
                    </motion.div>
                </div>
            </div>
        </div>
    );
}

export function Content() {
    const t = useTranslations("landing");
    const tCommon = useTranslations("common");
    const router = useRouter();
    const [onboardingPath, setOnboardingPath] = useState<
        "new_user" | "existing_user" | null
    >(null);
    const [contact, setContact] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);
    const landingViewTrackedRef = useRef(false);
    const {
        accountId,
        isInitializing,
        isAuthenticating,
        authError,
        clearError,
    } = useNear();
    const requestCreateTreasuryPromptOpen = useOnboardingStore(
        (state) => state.requestCreateTreasuryPromptOpen,
    );
    const { lastTreasuryId, treasuries, isLoading } = useTreasury();
    const { data: creationStatus } = useTreasuryCreationStatus();
    const creationAvailable = creationStatus?.creationAvailable;

    useEffect(() => {
        if (!authError) return;
        toast.error(authError, {
            duration: 8000,
            classNames: {
                toast: "!p-2 !px-4",
                title: "!pr-0",
            },
        });
    }, [authError]);

    const preferredTreasuryId =
        (lastTreasuryId &&
            treasuries.some((treasury) => treasury.daoId === lastTreasuryId) &&
            lastTreasuryId) ||
        treasuries[0]?.daoId;
    const showWhitelist =
        !!accountId &&
        !isLoading &&
        !isInitializing &&
        treasuries.length === 0 &&
        !creationAvailable;
    const shouldRedirectToTreasury = !!accountId && !!preferredTreasuryId;
    const isDecisionPending =
        isInitializing ||
        (!!accountId &&
            (isLoading ||
                shouldRedirectToTreasury ||
                typeof creationAvailable === "undefined"));
    const isResolvingExistingUserTreasury =
        onboardingPath === "existing_user" && !!accountId && isLoading;
    const isNewUserOptionLoading = isAuthenticating || isInitializing;
    const isExistingUserOptionLoading =
        isAuthenticating || isInitializing || isResolvingExistingUserTreasury;

    useEffect(() => {
        if (!isLoading && preferredTreasuryId) {
            router.push(`/${preferredTreasuryId}`);
        } else if (
            accountId &&
            treasuries.length === 0 &&
            !isLoading &&
            !isInitializing
        ) {
            if (onboardingPath === "new_user" && creationAvailable) {
                router.push(`/app/new?entry=new_user`);
            }
        }
    }, [
        treasuries,
        isLoading,
        router,
        accountId,
        isInitializing,
        preferredTreasuryId,
        creationAvailable,
        onboardingPath,
    ]);

    useEffect(() => {
        if (landingViewTrackedRef.current) return;
        landingViewTrackedRef.current = true;
        trackEvent("onboarding_landing_viewed", {
            source: "/",
        });
    }, []);

    const handleWhitelistSubmit = async () => {
        if (!contact.trim()) return;
        setIsSubmitting(true);
        try {
            await submitWhitelistRequest({
                contact: contact.trim(),
                accountId: accountId ?? undefined,
            });
            setSubmitted(true);
            trackEvent("waitlist-submitted", { account_id: accountId });
        } catch {
            toast.error(t("waitlistSubmitFailed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    const triggerWalletConnect = (path: "new_user" | "existing_user") => {
        if (authError) clearError();
        setOnboardingPath(path);
        trackEvent("onboarding_path_selected", {
            path,
        });

        if (path === "new_user") {
            router.push("/app/new?entry=new_user");
            return;
        }

        if (accountId && !isLoading && preferredTreasuryId) {
            router.push(`/${preferredTreasuryId}`);
            return;
        }

        if (accountId && !isLoading && treasuries.length === 0) {
            requestCreateTreasuryPromptOpen();
            return;
        }

        router.push("/login?context=existing_user");
    };

    if (isDecisionPending) {
        return <LoadingScreen />;
    }

    if (showWhitelist) {
        return (
            <WhitelistExperience
                contact={contact}
                setContact={setContact}
                submitted={submitted}
                isSubmitting={isSubmitting}
                onSubmit={handleWhitelistSubmit}
            />
        );
    }

    return (
        <div className="min-h-screen w-full overflow-y-auto bg-muted p-4 md:px-8 md:py-6">
            <div className="fixed top-3 right-3 z-50 md:top-6 md:right-6">
                <LanguageSwitcher variant="outline" />
            </div>
            <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-[1180px] items-start justify-center md:min-h-[calc(100vh-3rem)] md:items-center">
                <motion.div
                    className="w-full md:p-6"
                    initial={{
                        opacity: 0,
                        y: 30,
                        rotateX: 22,
                        scale: 0.98,
                    }}
                    animate={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
                    transition={{
                        duration: 0.55,
                        ease: [0.22, 1, 0.36, 1],
                    }}
                    style={{ transformOrigin: "center bottom" }}
                >
                    <div className="flex flex-col items-center text-center">
                        <FadeInUp delay={0.08} y={8}>
                            <Link href={LANDING_PAGE}>
                                <Logo size="lg" />
                            </Link>
                        </FadeInUp>
                        <div className="mt-10">
                            <WipeRevealText
                                className="text-2xl font-semibold tracking-tight text-foreground"
                                delay={0.16}
                                x={-18}
                                blur={10}
                                duration={0.55}
                            >
                                {t("welcome")}
                            </WipeRevealText>
                        </div>
                        <div className="mt-2">
                            <WipeRevealText
                                className="text-md text-muted-foreground"
                                delay={0.26}
                                x={-14}
                            >
                                {t("chooseOption")}
                            </WipeRevealText>
                        </div>
                    </div>

                    <motion.div
                        className="mx-auto mt-10 w-full max-w-[320px] rounded-2xl border border-border bg-card p-4 md:max-w-[704px] md:p-5 lg:max-w-[784px]"
                        initial={{ opacity: 0, y: 16 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{
                            duration: 0.4,
                            ease: "easeOut",
                            delay: 0.36,
                        }}
                    >
                        <div className="grid w-full grid-cols-1 justify-items-center gap-5 md:grid-cols-2 md:gap-6">
                            <FadeInUp className="w-full" delay={0.44}>
                                <OnboardingChoiceCard
                                    icon={Compass}
                                    title={t("newUserTitle")}
                                    description={t("newUserDescription")}
                                    active={onboardingPath !== "existing_user"}
                                    onClick={() =>
                                        triggerWalletConnect("new_user")
                                    }
                                    disabled={isNewUserOptionLoading}
                                />
                            </FadeInUp>
                            <FadeInUp className="w-full" delay={0.5}>
                                <OnboardingChoiceCard
                                    icon={UserCheck}
                                    title={t("existingUserTitle")}
                                    description={t("existingUserDescription")}
                                    active={onboardingPath === "existing_user"}
                                    onClick={() =>
                                        triggerWalletConnect("existing_user")
                                    }
                                    disabled={isExistingUserOptionLoading}
                                />
                            </FadeInUp>
                        </div>
                    </motion.div>
                </motion.div>
            </div>
        </div>
    );
}

export default function Page() {
    return (
        <QueryProvider>
            <NearInitializer />
            <AuthProvider>
                <Content />
            </AuthProvider>
        </QueryProvider>
    );
}
