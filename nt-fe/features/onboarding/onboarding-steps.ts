export const ONBOARDING_STEP_IDS = [
    "add-team-member",
    "setup-threshold",
    "add-assets",
    "create-payment",
] as const;

export type OnboardingStepId = (typeof ONBOARDING_STEP_IDS)[number];

/** Also completes setup-threshold — a solo treasury has no voting setup. */
export function soloSelectedKey(treasuryId: string) {
    return `onboarding:solo-selected:${treasuryId}`;
}

/** Written after a successful ChangePolicy / duration proposal, or when deferred. */
export function thresholdSetupKey(treasuryId: string) {
    return `onboarding:threshold-setup:${treasuryId}`;
}

/** Later is only offered after a teammate is added, not on the solo path. */
export function canDeferThresholdSetup(flags: {
    addedMember: boolean;
    thresholdComplete: boolean;
}): boolean {
    return flags.addedMember && !flags.thresholdComplete;
}

export function readOnboardingFlag(key: string): boolean {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(key) === "true";
}

export function writeOnboardingFlag(key: string): void {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, "true");
}

export function getOnboardingStepStatus(flags: {
    hasTeam: boolean;
    hasThreshold: boolean;
    hasAssets: boolean;
    hasPayment: boolean;
}) {
    const completed: Record<OnboardingStepId, boolean> = {
        "add-team-member": flags.hasTeam,
        "setup-threshold": flags.hasThreshold,
        "add-assets": flags.hasAssets,
        "create-payment": flags.hasPayment,
    };
    const completedCount = ONBOARDING_STEP_IDS.filter(
        (id) => completed[id],
    ).length;
    const activeId = ONBOARDING_STEP_IDS.find((id) => !completed[id]) ?? null;

    return {
        completed,
        completedCount,
        total: ONBOARDING_STEP_IDS.length,
        allComplete: completedCount === ONBOARDING_STEP_IDS.length,
        activeId,
        isActive: (id: OnboardingStepId) => activeId === id,
    };
}

export function isChangePolicyProposalKind(kind: unknown): boolean {
    return (
        !!kind &&
        typeof kind === "object" &&
        ("ChangePolicy" in kind || "ChangePolicyUpdateParameters" in kind)
    );
}
