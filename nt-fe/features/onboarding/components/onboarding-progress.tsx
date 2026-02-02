"use client";

import { useMemo } from "react";
import { useRouter, useParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { ArrowDownToLine, ArrowUpRight } from "lucide-react";
import { Button } from "@/components/button";
import { StepIcon } from "@/features/proposals/components/expanded-view/common/proposal-sidebar";
import { useAssets } from "@/hooks/use-assets";
import { TreasuryAsset } from "@/lib/api";
import Big from "big.js";
import { useProposals } from "@/hooks/use-proposals";
import { useTreasury } from "@/hooks/use-treasury";
import { availableBalance } from "@/lib/balance";

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
    const progress = current / total;
    const arcLength = 440; // 2 * PI * 70 (approx circumference)
    const dashArray = 220; // Half circle

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
                    <mask id="progress-mask">
                        <circle
                            cx="82.5"
                            cy="88.8"
                            r="70"
                            fill="none"
                            stroke="white"
                            strokeWidth="120"
                            strokeDasharray={`${dashArray} ${arcLength - dashArray}`}
                            strokeDashoffset={dashArray * (1 - progress)}
                            transform="rotate(180 82.5 88.8)"
                            className="transition-[stroke-dashoffset] duration-1000 ease-in-out"
                        />
                    </mask>
                    <linearGradient
                        id="progress-gradient"
                        x1="0%"
                        y1="0%"
                        x2="100%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            stopColor="#48ACEF"
                            className="dark:[stop-color:#D4EEFF]"
                        />
                        <stop
                            offset="100%"
                            stopColor="#A8DCFF"
                            className="dark:[stop-color:#A8DCFF]"
                        />
                    </linearGradient>
                    <clipPath id="svg-draw">
                        <path d={PROGRESS_ARC_PATH} />
                    </clipPath>
                </defs>

                {/* Background Arc */}
                <path
                    d={PROGRESS_ARC_PATH}
                    fill="#CFD4DB61"
                    fillOpacity="0.38"
                />
                <path
                    clipPath="url(#svg-draw)"
                    d={PROGRESS_ARC_PATH}
                    fill="url(#progress-gradient)"
                    mask="url(#progress-mask)"
                />
            </svg>

            <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-foreground text-base font-bold z-10">
                {current}/{total}
            </span>
        </div>
    );
}

function StepCard({ step, index }: { step: OnboardingStep; index: number }) {
    const isCompleted = step.completed;
    const isActive = step.active;
    return (
        <div
            className={cn(
                "flex flex-col gap-2 lg:flex-row lg:items-center items-start p-3 rounded-[10.5px] w-full",
                isActive
                    ? "bg-linear-to-r from-[#E2F2FF] to-[#D4EBFF] dark:from-[rgba(23,81,132,0.55)] dark:to-[rgba(23,81,132,0.71)]"
                    : "bg-secondary dark:bg-linear-to-r dark:from-[rgba(13,39,62,0.5)] dark:to-[rgba(4,25,17,0.5)] ",
            )}
        >
            <div className="flex flex-1 gap-3 items-start">
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
                    <p className="text-sm font-semibold">
                        {index + 1}. {step.title}
                    </p>
                    <span>{step.description}</span>
                </div>
            </div>

            {step.action && !isCompleted && (
                <Button
                    variant={isActive ? "default" : "ghost"}
                    onClick={step.action.onClick}
                >
                    {step.action.icon === "deposit" ? (
                        <ArrowDownToLine className="size-3.5" />
                    ) : (
                        <ArrowUpRight className="size-3.5" />
                    )}
                    {step.action.label}
                </Button>
            )}
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
    const router = useRouter();
    const {
        isGuestTreasury,
        isLoading: isLoadingGuestTreasury,
        treasuryId,
    } = useTreasury();
    const { data, isLoading: isLoadingAssets } = useAssets(treasuryId);
    const { tokens } = data || { tokens: [] };
    const { data: proposals, isLoading: isLoadingProposals } = useProposals(
        treasuryId,
        {
            types: ["Payments"],
        },
    );

    const isLoading =
        isLoadingAssets || isLoadingProposals || isLoadingGuestTreasury;

    const tokenBalanceIsPositive = (token: TreasuryAsset) => {
        const tokenBalance = Big(availableBalance(token.balance)).div(
            Big(10).pow(token.decimals),
        );
        if (token.symbol === "NEAR") {
            return tokenBalance.gt(1);
        }
        return true;
    };
    const hasAssets = tokens.filter(tokenBalanceIsPositive).length > 0;

    const steps: OnboardingStep[] = useMemo(() => {
        let activeStep = 1;

        const step2Completed = hasAssets;
        const step3Completed =
            !!proposals?.proposals?.length && proposals.proposals.length > 0;

        if (!step3Completed) activeStep = 3;
        if (!hasAssets) activeStep = 2;

        return [
            {
                id: "create-treasury",
                title: "Create Treasury account",
                description:
                    "You've successfully set up your account. Great start!",
                completed: true,
                active: false,
            },
            {
                id: "add-assets",
                title: "Add Your Assets",
                description: "Begin by adding assets to see them in action.",
                completed: step2Completed,
                active: activeStep === 2,
                action: {
                    label: "Deposit",
                    icon: "deposit" as const,
                    onClick: () => onDepositClick?.() || (() => {}),
                },
            },
            {
                id: "create-payment",
                title: "Create a Payment Request",
                description: "Create a payment request to complete your setup.",
                completed: step3Completed,
                active: activeStep === 3,
                action: {
                    label: "Send",
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
    }, [hasAssets, proposals, treasuryId, router, onDepositClick]);

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
                    Follow Quick Steps to
                    <br />
                    Explore the Treasury
                </p>
            </div>

            {/* Right section - Step cards */}
            <div className="relative z-10 flex flex-col gap-2 flex-1 min-w-0">
                {steps.map((step, index) => (
                    <StepCard key={step.id} step={step} index={index} />
                ))}
            </div>
        </div>
    );
}
