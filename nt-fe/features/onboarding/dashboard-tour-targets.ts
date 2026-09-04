import { useMobileShellStore } from "@/stores/mobile-shell-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useSidebarStore } from "@/stores/sidebar-store";

/** 0-indexed dashboard tour steps that live in the mobile Menu sheet. */
export const DASHBOARD_TOUR_MENU_STEPS = [1, 2, 3] as const;

/** 0-indexed dashboard tour step that lives in the treasury selector / sheet. */
export const DASHBOARD_TOUR_TREASURY_STEP = 4;

export type DashboardTourSurface = "page" | "menu" | "treasury";

const menuSteps = new Set<number>(DASHBOARD_TOUR_MENU_STEPS);

export function dashboardTourSurface(stepIndex: number): DashboardTourSurface {
    if (menuSteps.has(stepIndex)) return "menu";
    if (stepIndex === DASHBOARD_TOUR_TREASURY_STEP) return "treasury";
    return "page";
}

export type DashboardTourSide = "bottom" | "right" | "top-left" | "top-right";

export type HelpSupportTourSide = "bottom-right" | "right";

export const HELP_SUPPORT_DESKTOP_SELECTOR = "#help-support-link";
export const HELP_SUPPORT_MOBILE_SELECTOR =
    "[data-testid='mobile-user-trigger']";

/** Profile control: sidebar account row on desktop, header avatar on phones. */
export function helpSupportTourSelector(
    mobile = isTourMobileViewport(),
): string {
    return mobile
        ? HELP_SUPPORT_MOBILE_SELECTOR
        : HELP_SUPPORT_DESKTOP_SELECTOR;
}

/**
 * Desktop: sit to the right of the sidebar account row.
 * Mobile: hang below the top-right header avatar, right-aligned so the card
 * grows left into the screen instead of clipping off the edge or flipping
 * above the header.
 */
export function helpSupportTourStepSide(
    mobile = isTourMobileViewport(),
): HelpSupportTourSide {
    return mobile ? "bottom-right" : "right";
}

/** Tight to the header avatar on phones; keep the default rail gap on desktop. */
export function helpSupportTourCardOffset(
    mobile = isTourMobileViewport(),
): number {
    return mobile ? 6 : 25;
}

/**
 * Create Treasury sits at the bottom of the dropdown/sheet on every screen, so
 * its card always goes above it. On small screens the nav tiles pin Send to the
 * left edge and Swap to the right edge so neither card is cut off.
 */
export function dashboardTourStepSide(
    stepIndex: number,
    mobile = isTourMobileViewport(),
): DashboardTourSide {
    if (stepIndex === 0) return "bottom";
    if (stepIndex === DASHBOARD_TOUR_TREASURY_STEP) return "top-left";
    if (!mobile) return "right";
    return stepIndex === 2 ? "top-right" : "top-left";
}

export const DASHBOARD_TOUR_SELECTOR_RETRY = {
    selectorRetryAttempts: 20,
    selectorRetryDelay: 100,
} as const;

export function isTourMobileViewport() {
    return typeof window !== "undefined" && window.innerWidth < 1024;
}

const CREATE_TREASURY_TARGET_ID = "dashboard-step5-create-treasury";
const CREATE_TREASURY_TARGET_ATTR = "data-tour-create-treasury";

/**
 * The desktop dropdown and the mobile sheet each render a Create Treasury row,
 * so the tour ID is moved onto whichever one is currently rendered — a
 * duplicated ID would leave `querySelector` pointing at the hidden copy.
 */
function markVisibleCreateTreasuryTarget() {
    const rows = document.querySelectorAll(`[${CREATE_TREASURY_TARGET_ATTR}]`);
    for (const row of rows) {
        row.removeAttribute("id");
    }
    // The open portal is last in the DOM when both surfaces are mounted.
    const target = Array.from(rows)
        .filter((row) => row.getClientRects().length > 0)
        .at(-1);
    target?.setAttribute("id", CREATE_TREASURY_TARGET_ID);
}

/** Rounded rect signature, or "" when the target is missing or unrendered. */
function targetGeometry(selector: string) {
    const rect = document.querySelector(selector)?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return "";
    return [rect.top, rect.left, rect.width, rect.height]
        .map(Math.round)
        .join(":");
}

const SETTLED_FRAMES = 3;
const SETTLE_TIMEOUT_MS = 1500;

/**
 * Resolves once the step's target has been laid out and stopped moving.
 *
 * nextstepjs measures the target exactly once per step change, and both tour
 * surfaces animate in (the dropdown zooms, the sheets slide). Measuring
 * mid-animation reads a transformed rect, which is what left the Create
 * Treasury highlight and card floating away from the button.
 */
export function waitForSettledTourTarget(selector?: string) {
    if (typeof document === "undefined" || !selector) return Promise.resolve();

    return new Promise<void>((resolve) => {
        const deadline = Date.now() + SETTLE_TIMEOUT_MS;
        let previous = "";
        let settledFrames = 0;

        const tick = () => {
            markVisibleCreateTreasuryTarget();

            const geometry = targetGeometry(selector);
            settledFrames =
                geometry && geometry === previous ? settledFrames + 1 : 0;
            previous = geometry;

            if (settledFrames >= SETTLED_FRAMES || Date.now() >= deadline) {
                resolve();
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

/**
 * Opens the one surface the given step needs (mobile Menu sheet, mobile
 * treasury sheet, or desktop treasury dropdown) and closes the others, so
 * stepping backwards reveals the previous target instead of leaving the
 * dropdown covering it.
 */
function prepareDashboardTourStep(stepIndex: number) {
    const { openSheet, closeSheet } = useMobileShellStore.getState();
    const { setTreasurySelectorOpen } = useOnboardingStore.getState();
    const surface = dashboardTourSurface(stepIndex);

    if (isTourMobileViewport()) {
        setTreasurySelectorOpen(false);
        if (surface === "page") closeSheet();
        else openSheet(surface);
        return;
    }

    closeSheet();
    if (surface !== "page") {
        useSidebarStore.getState().setSidebarOpen(true);
    }
    setTreasurySelectorOpen(surface === "treasury");
}

export function applyDashboardTourStep(
    stepIndex: number,
    step?: { side?: string },
) {
    if (step) {
        step.side = dashboardTourStepSide(stepIndex);
    }
    prepareDashboardTourStep(stepIndex);
}

export function closeDashboardTourSurfaces() {
    useMobileShellStore.getState().closeSheet();
    useOnboardingStore.getState().setTreasurySelectorOpen(false);
}
