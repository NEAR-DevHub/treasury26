import { describe, expect, it } from "bun:test";
import {
    canDeferThresholdSetup,
    getOnboardingStepStatus,
    ONBOARDING_STEP_IDS,
} from "./onboarding-steps";

describe("getOnboardingStepStatus", () => {
    it("starts on add-team-member with 0/4 complete", () => {
        const status = getOnboardingStepStatus({
            hasTeam: false,
            hasThreshold: false,
            hasAssets: false,
            hasPayment: false,
        });

        expect(status.completedCount).toBe(0);
        expect(status.total).toBe(4);
        expect(status.allComplete).toBe(false);
        expect(status.activeId).toBe("add-team-member");
        expect(status.isActive("add-team-member")).toBe(true);
        expect(status.isActive("setup-threshold")).toBe(false);
    });

    it("advances to setup-threshold after the team step", () => {
        const status = getOnboardingStepStatus({
            hasTeam: true,
            hasThreshold: false,
            hasAssets: false,
            hasPayment: false,
        });

        expect(status.completedCount).toBe(1);
        expect(status.activeId).toBe("setup-threshold");
        expect(status.completed["add-team-member"]).toBe(true);
    });

    it("keeps the first incomplete step active even if later steps are done", () => {
        const status = getOnboardingStepStatus({
            hasTeam: false,
            hasThreshold: true,
            hasAssets: true,
            hasPayment: false,
        });

        expect(status.completedCount).toBe(2);
        expect(status.activeId).toBe("add-team-member");
    });

    it("offers Later only after a teammate is added and threshold is open", () => {
        expect(
            canDeferThresholdSetup({
                addedMember: true,
                thresholdComplete: false,
            }),
        ).toBe(true);
        expect(
            canDeferThresholdSetup({
                addedMember: false,
                thresholdComplete: false,
            }),
        ).toBe(false);
        expect(
            canDeferThresholdSetup({
                addedMember: true,
                thresholdComplete: true,
            }),
        ).toBe(false);
    });

    it("marks all four steps complete", () => {
        const status = getOnboardingStepStatus({
            hasTeam: true,
            hasThreshold: true,
            hasAssets: true,
            hasPayment: true,
        });

        expect(status.completedCount).toBe(ONBOARDING_STEP_IDS.length);
        expect(status.allComplete).toBe(true);
        expect(status.activeId).toBeNull();
    });
});
