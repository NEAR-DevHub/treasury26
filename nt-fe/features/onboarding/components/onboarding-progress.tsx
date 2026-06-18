"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { ArrowDownToLine, ArrowUpRight, Plus } from "lucide-react";
import { Button } from "@/components/button";
import { StepIcon } from "@/components/step-icon";
import { useAssets } from "@/hooks/use-assets";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasuryMembers } from "@/hooks/use-treasury-members";
import { useTreasury } from "@/hooks/use-treasury";
import { availableBalance } from "@/lib/balance";
import {
    buildPaymentPendingRefetchInterval,
    clearPaymentPending,
} from "@/features/onboarding/payment-pending";

export type OnboardingStep = {
    id: string;
    title: string;
    description: string;
    completed: boolean;
    active?: boolean;
    action?: {
        label: string;
        icon: "deposit" | "send";
        onClick: () => void;
    };
    secondaryAction?: {
        label: string;
        onClick: () => void;
    };
};

interface OnboardingProgressProps {
    className?: string;
    onDepositClick?: () => void;
}

const PROGRESS_ARC_PATH =
    "M159.809 108.299C160.333 108.473 160.9 108.191 161.068 107.665C164.987 95.4313 165.995 82.4472 164.008 69.7471C161.97 56.7175 156.837 44.3665 149.041 33.7295C141.245 23.0925 131.012 14.4796 119.201 8.61278C107.389 2.74597 94.3435 -0.203743 81.1571 0.0109305C67.9707 0.225604 55.0279 3.59841 43.4138 9.84658C31.7997 16.0948 21.8528 25.0362 14.4069 35.9213C6.96096 46.8064 2.23313 59.318 0.619707 72.4071C-0.952916 85.1652 0.478036 98.1095 4.79238 110.209C4.97788 110.729 5.55383 110.993 6.07175 110.801L21.2167 105.193C21.7347 105.001 21.9983 104.426 21.8145 103.906C18.5067 94.5277 17.4157 84.506 18.6334 74.6275C19.8918 64.418 23.5796 54.659 29.3874 46.1686C35.1951 37.6782 42.9538 30.7039 52.0128 25.8303C61.0718 20.9568 71.1671 18.326 81.4525 18.1585C91.7379 17.9911 101.914 20.2919 111.126 24.868C120.339 29.4441 128.321 36.1622 134.402 44.459C140.483 52.7558 144.486 62.3896 146.077 72.5527C147.615 82.3864 146.851 92.4382 143.85 101.919C143.683 102.445 143.966 103.012 144.489 103.186L159.809 108.299Z";

function SemiCircleProgress({
    current,
    total,
}: {
    current: number;
    total: number;
}) {
    const id = useId();
    const progress = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;
    const hasProgress = progress > 0;
    const progressMaskWidth = 165 * progress;
    const progressMaskId = `${id}-progress-mask`;
    const arcClipPathId = `${id}-arc-clip`;

    return (
        <div className="relative flex items-center justify-center w-[165px] h-[111px]">
            <svg
                width="165"
                height="111"
                viewBox="0 0 165 111"
                fill="none"
                xmlns="http://www.w3.org/2000/svg"
            >
                <defs>
                    <mask id={progressMaskId}>
                        <rect width="165" height="111" fill="black" />
                        <rect
                            x="0"
                            y="0"
                            width={progressMaskWidth}
                            height="111"
                            fill="white"
                            className="transition-[width] duration-1000 ease-in-out"
                        />
                    </mask>
                    <linearGradient
                        id="progress-gradient"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="0%"
                        gradientTransform="rotate(181 0.5 0.5)"
                    >
                        <stop offset="0.89%" stopColor="#48ACEF" />
                        <stop offset="66.39%" stopColor="#A8DCFF" />
                    </linearGradient>
                    <clipPath id={arcClipPathId}>
                        <path d={PROGRESS_ARC_PATH} />
                    </clipPath>
                </defs>

                {/* Background Arc */}
                <path
                    d={PROGRESS_ARC_PATH}
                    fill="#CFD4DB61"
                    fillOpacity="0.38"
                />
                {hasProgress ? (
                    <path
                        clipPath={`url(#${arcClipPathId})`}
                        d={PROGRESS_ARC_PATH}
                        fill="url(#progress-gradient)"
                        mask={`url(#${progressMaskId})`}
                    />
                ) : null}
            </svg>

            <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-foreground text-base font-bold z-10">
                {current}/{total}
            </span>
        </div>
    );
}

function StepCard({ step }: { step: OnboardingStep }) {
    const isCompleted = step.completed;
    const isActive = step.active;
    const primaryAction = step.action;
    const secondaryAction = step.secondaryAction;
    const hasInlineDualActions =
        !isCompleted && !!primaryAction && !!secondaryAction;
    const activeStepClassName =
        "border border-transparent [background:linear-gradient(#EFF6FF,#EFF6FF)_padding-box,linear-gradient(180deg,rgba(9,83,255,0.28),rgba(9,83,255,0.05))_border-box] dark:[background:linear-gradient(#080E22,#080E22)_padding-box,linear-gradient(180deg,rgba(9,83,255,0.44),rgba(9,83,255,0.24))_border-box]";
    return (
        <div
            className={cn(
                "flex flex-col gap-2 xl:flex-row xl:items-center items-start p-3 rounded-[10.5px] overflow-hidden w-full",
                isActive
                    ? activeStepClassName
                    : "bg-secondary justify-center xl:justify-start",
            )}
        >
            <div className="flex flex-1 gap-3 items-center xl:items-start">
                <div className="pt-0.5">
                    <StepIcon
                        status={isCompleted ? "Success" : "Pending"}
                        size="sm"
                    />
                </div>
                <div
                    className={cn(
                        "flex flex-col gap-0.5 flex-1 min-w-0",
                        "text-xs tracking-wide",
                        isCompleted
                            ? "text-muted-foreground"
                            : "text-foreground",
                    )}
                >
                    <p className="text-sm font-semibold">{step.title}</p>
                    {isActive && (
                        <span className="text-muted-foreground">
                            {step.description}
                        </span>
                    )}
                    {hasInlineDualActions && (
                        <div className="mt-2 flex items-center gap-1.5">
                            <Button
                                variant="default"
                                onClick={primaryAction!.onClick}
                            >
                                <Plus className="size-4" />
                                {primaryAction!.label}
                            </Button>
                            <Button
                                variant="unstyled"
                                onClick={secondaryAction!.onClick}
                                className="px-2 h-auto"
                            >
                                {secondaryAction!.label}
                            </Button>
                        </div>
                    )}
                </div>
            </div>

            {!isCompleted && step.action && !step.secondaryAction ? (
                <Button
                    variant="unstyled"
                    onClick={step.action.onClick}
                    className="self-start ml-4 w-auto p-0 h-auto xl:ml-0 xl:self-center xl:mx-auto"
                >
                    {step.action.icon === "deposit" ? (
                        <ArrowDownToLine className="size-3.5" />
                    ) : (
                        <ArrowUpRight className="size-3.5" />
                    )}
                    {step.action.label}
                </Button>
            ) : null}
        </div>
    );
}

function GradientGlow({ className }: { className?: string }) {
    return (
        <div
            className={cn(
                "absolute w-[201px] h-[63px] blur-[67px] rounded-full hidden dark:block",
                className,
            )}
            style={{
                backgroundImage:
                    "linear-gradient(200deg, rgba(31, 156, 240, 0) 10%, rgba(31, 156, 240, 0.4) 27%, rgba(31, 156, 240, 0.4) 74%, rgba(31, 156, 240, 0) 109%)",
            }}
        />
    );
}

export function OnboardingProgress({
    className,
    onDepositClick,
}: OnboardingProgressProps) {
    const t = useTranslations("onboarding.progress");
    const tCreateTreasury = useTranslations("createTreasury");
    const router = useRouter();
    const {
        isGuestTreasury,
        isLoading: isLoadingGuestTreasury,
        treasuryId,
    } = useTreasury();
    const { data, isLoading: isLoadingAssets } = useAssets(treasuryId);
    const { members, isLoading: isLoadingMembers } =
        useTreasuryMembers(treasuryId);
    const { tokens } = data || { tokens: [] };
    const { data: proposals, isLoading: isLoadingProposals } = useProposals(
        treasuryId,
        {
            types: ["Payments"],
        },
        true,
        {
            refetchOnMount: "always",
            refetchInterval: buildPaymentPendingRefetchInterval(treasuryId),
        },
    );
    const [soloSelected, setSoloSelected] = useState(false);

    useEffect(() => {
        if (treasuryId && (proposals?.proposals?.length ?? 0) > 0) {
            clearPaymentPending(treasuryId);
        }
    }, [proposals, treasuryId]);

    useEffect(() => {
        if (!treasuryId || typeof window === "undefined") return;
        const value = window.localStorage.getItem(
            `onboarding:solo-selected:${treasuryId}`,
        );
        setSoloSelected(value === "true");
    }, [treasuryId]);

    const isLoading =
        isLoadingAssets ||
        isLoadingProposals ||
        isLoadingGuestTreasury ||
        isLoadingMembers;

    const hasAssets =
        tokens.filter((token) => availableBalance(token.balance).gt(0)).length >
        0;
    const hasAddedTeamMember = members.length > 1 || soloSelected;

    const steps: OnboardingStep[] = useMemo(() => {
        const step1Completed = hasAddedTeamMember;
        const step2Completed = hasAssets;
        const step3Completed =
            !!proposals?.proposals?.length && proposals.proposals.length > 0;
        const activeStep = !step1Completed ? 1 : !step2Completed ? 2 : 3;

        const handleUseSolo = () => {
            if (!treasuryId || typeof window === "undefined") return;
            window.localStorage.setItem(
                `onboarding:solo-selected:${treasuryId}`,
                "true",
            );
            setSoloSelected(true);
        };

        return [
            {
                id: "add-team-member",
                title: t("addTeamMemberTitle"),
                description: t("addTeamMemberDescription"),
                completed: step1Completed,
                active: activeStep === 1,
                action: {
                    label: tCreateTreasury("addMembers"),
                    icon: "send",
                    onClick: () =>
                        router.push(
                            treasuryId ? `/${treasuryId}/members` : "/members",
                        ),
                },
                secondaryAction: {
                    label: t("useSolo"),
                    onClick: handleUseSolo,
                },
            },
            {
                id: "add-assets",
                title: t("addAssetsTitle"),
                description: t("addAssetsDescription"),
                completed: step2Completed,
                active: activeStep === 2,
                action: {
                    label: t("deposit"),
                    icon: "deposit" as const,
                    onClick: () => onDepositClick?.() || (() => {}),
                },
            },
            {
                id: "create-payment",
                title: t("createPaymentTitle"),
                description: t("createPaymentDescription"),
                completed: step3Completed,
                active: activeStep === 3,
                action: {
                    label: t("send"),
                    icon: "send" as const,
                    onClick: () =>
                        router.push(
                            treasuryId
                                ? `/${treasuryId}/payments`
                                : "/payments",
                        ),
                },
            },
        ];
    }, [
        hasAddedTeamMember,
        hasAssets,
        proposals,
        treasuryId,
        router,
        onDepositClick,
        t,
        tCreateTreasury,
    ]);

    const completedSteps = steps.filter((s) => s.completed).length;

    // Don't show onboarding if all steps are completed
    const showOnboarding =
        completedSteps < steps.length && !isLoading && !isGuestTreasury;

    if (!showOnboarding) {
        return null;
    }

    return (
        <div
            className={cn(
                "relative flex md:flex-row flex-col gap-6 items-center overflow-hidden px-5 py-4 rounded-xl bg-general-tertiary dark:bg-black",
                className,
            )}
        >
            <GradientGlow className="left-[-122px] top-[-6px]" />
            <GradientGlow className="right-[-122px] top-[-4px]" />
            {/* Left section - Progress indicator */}
            <div className="relative z-10 flex flex-col gap-4 items-center justify-center shrink-0 w-[209px] ">
                <SemiCircleProgress
                    current={completedSteps}
                    total={steps.length}
                />
                <p className="text-base font-semibold text-foreground text-center leading-snug">
                    {t("title")}
                </p>
            </div>

            {/* Right section - Step cards */}
            <div className="relative z-10 flex flex-col gap-2 flex-1 min-w-0">
                {steps.map((step) => (
                    <StepCard key={step.id} step={step} />
                ))}
            </div>
        </div>
    );
}
