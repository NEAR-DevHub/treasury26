"use client";

import {
    ArrowDown01Icon,
    ArrowRight01Icon,
    CheckIcon,
} from "@hugeicons/core-free-icons";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { Icon } from "@/components/icon";
import { cn } from "@/lib/utils";
import { useOnboardingSteps } from "../hooks/use-onboarding-steps";
import type { OnboardingStepId } from "../onboarding-steps";

type GetStartedVariant = "rail" | "page";

interface GetStartedCardProps {
    variant?: GetStartedVariant;
    hidden?: boolean;
}

export function GetStartedCard({
    variant = "page",
    hidden = false,
}: GetStartedCardProps) {
    const t = useTranslations("onboarding.progress");
    const router = useRouter();
    const [collapsed, setCollapsed] = useState(false);
    const {
        treasuryId,
        isGuestTreasury,
        isLoading,
        status,
        markSolo,
        markThresholdLater,
        canDeferThreshold,
    } = useOnboardingSteps();

    if (hidden || isGuestTreasury || isLoading || status.allComplete) {
        return null;
    }

    const hrefFor = (id: OnboardingStepId) => {
        if (!treasuryId) return "/";
        switch (id) {
            case "add-team-member":
                return `/${treasuryId}/members`;
            case "setup-threshold":
                return `/${treasuryId}/settings?tab=voting`;
            case "add-assets":
                return `/${treasuryId}/dashboard/deposit`;
            case "create-payment":
                return `/${treasuryId}/payments`;
        }
    };

    const steps: { id: OnboardingStepId; title: string }[] = [
        { id: "add-team-member", title: t("addTeamMemberTitle") },
        { id: "setup-threshold", title: t("setupThresholdTitle") },
        { id: "add-assets", title: t("addAssetsTitle") },
        { id: "create-payment", title: t("createPaymentShort") },
    ];

    return (
        <div
            className={cn(
                "flex w-full flex-col gap-3 rounded-3xl p-4",
                variant === "rail" ? "bg-gray-900" : "bg-card",
            )}
        >
            <button
                type="button"
                onClick={() => setCollapsed((value) => !value)}
                aria-expanded={!collapsed}
                className="flex w-full cursor-pointer items-center justify-between gap-2 text-left"
            >
                <span className="text-base font-semibold leading-[1.2] text-general-foreground">
                    {t("getStarted")}
                </span>
                <span className="flex shrink-0 items-center gap-2">
                    {collapsed && (
                        <CircularProgress
                            current={status.completedCount}
                            total={status.total}
                        />
                    )}
                    <Icon
                        icon={ArrowDown01Icon}
                        className={cn(
                            "size-4 text-general-foreground transition-transform duration-150",
                            collapsed && "-rotate-90",
                        )}
                    />
                </span>
            </button>

            {!collapsed && (
                <div className="flex items-center gap-2.5">
                    <div
                        className={cn(
                            "h-1 flex-1 overflow-hidden rounded-[0.625rem]",
                            variant === "rail"
                                ? "bg-general-unofficial-accent"
                                : "bg-gray-200 dark:bg-white/10",
                        )}
                    >
                        <div
                            className={cn(
                                "h-full rounded-[0.625rem] transition-[width] duration-300",
                                variant === "rail"
                                    ? "bg-white"
                                    : "bg-gray-900 dark:bg-white",
                            )}
                            style={{
                                width: `${(status.completedCount / status.total) * 100}%`,
                            }}
                        />
                    </div>
                    <span
                        className={cn(
                            "shrink-0 text-sm font-normal leading-[1.5] tracking-[0.00438rem]",
                            variant === "rail"
                                ? "text-muted-foreground"
                                : "text-gray-400",
                        )}
                    >
                        {status.completedCount}/{status.total}
                    </span>
                </div>
            )}

            {!collapsed && (
                <div className="flex flex-col">
                    {steps.map((step) => {
                        const completed = status.completed[step.id];
                        const active = status.isActive(step.id);
                        const muted = !completed && !active;
                        const showSolo =
                            step.id === "add-team-member" && active;
                        const showLater =
                            step.id === "setup-threshold" &&
                            active &&
                            canDeferThreshold;

                        return (
                            <div key={step.id} className="py-1.5">
                                <button
                                    type="button"
                                    onClick={() =>
                                        router.push(hrefFor(step.id))
                                    }
                                    className="flex w-full cursor-pointer items-center gap-2.5 text-left"
                                >
                                    <StepCircle
                                        completed={completed}
                                        variant={variant}
                                    />
                                    <span
                                        className={cn(
                                            "min-w-0 flex-1 overflow-hidden text-ellipsis text-sm font-medium leading-[1.5]",
                                            variant === "rail"
                                                ? completed
                                                    ? "text-general-muted-foreground line-through"
                                                    : active
                                                      ? "text-white"
                                                      : "text-muted-foreground"
                                                : completed
                                                  ? "text-gray-400 line-through"
                                                  : active
                                                    ? "text-gray-900 dark:text-white"
                                                    : "text-gray-400",
                                        )}
                                    >
                                        {step.title}
                                    </span>
                                    <Icon
                                        icon={ArrowRight01Icon}
                                        className={cn(
                                            "size-4 shrink-0",
                                            variant === "rail"
                                                ? muted
                                                    ? "text-muted-foreground"
                                                    : "text-white"
                                                : muted
                                                  ? "text-gray-400"
                                                  : "text-gray-900 dark:text-white",
                                        )}
                                    />
                                </button>
                                {showSolo && (
                                    <button
                                        type="button"
                                        onClick={markSolo}
                                        className={cn(
                                            "mt-1 ml-8 cursor-pointer text-xs font-bold leading-3",
                                            variant === "rail"
                                                ? "text-general-unofficial-ghost-foreground"
                                                : "text-gray-900 dark:text-white",
                                        )}
                                    >
                                        {t("useSoloLink")}
                                    </button>
                                )}
                                {showLater && (
                                    <button
                                        type="button"
                                        onClick={markThresholdLater}
                                        className={cn(
                                            "mt-1 ml-8 cursor-pointer text-xs font-bold leading-3",
                                            variant === "rail"
                                                ? "text-general-unofficial-ghost-foreground"
                                                : "text-gray-900 dark:text-white",
                                        )}
                                    >
                                        {t("setupThresholdLater")}
                                    </button>
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

export function SidebarOnboarding({ isReduced }: { isReduced: boolean }) {
    return <GetStartedCard variant="rail" hidden={isReduced} />;
}

function StepCircle({
    completed,
    variant,
}: {
    completed: boolean;
    variant: GetStartedVariant;
}) {
    if (completed) {
        return (
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-general-success-background-faded">
                <Icon
                    icon={CheckIcon}
                    className="size-3 text-general-success-foreground"
                />
            </span>
        );
    }

    if (variant === "rail") {
        return <span className="size-5 shrink-0 rounded-full bg-white/10" />;
    }

    return (
        <span className="size-5 shrink-0 rounded-full border border-dashed border-gray-300 dark:border-white/20" />
    );
}

function CircularProgress({
    current,
    total,
}: {
    current: number;
    total: number;
}) {
    const size = 22;
    const stroke = 2.5;
    const radius = (size - stroke) / 2;
    const circumference = 2 * Math.PI * radius;
    const progress = total > 0 ? Math.min(Math.max(current / total, 0), 1) : 0;

    return (
        <svg
            width={size}
            height={size}
            viewBox={`0 0 ${size} ${size}`}
            className="-rotate-90"
            aria-hidden="true"
        >
            <circle
                cx={size / 2}
                cy={size / 2}
                r={radius}
                fill="none"
                stroke="currentColor"
                strokeWidth={stroke}
                className="text-gray-200 dark:text-white/15"
            />
            {progress > 0 && (
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={radius}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={circumference * (1 - progress)}
                    className="text-gray-900 dark:text-white"
                />
            )}
        </svg>
    );
}
