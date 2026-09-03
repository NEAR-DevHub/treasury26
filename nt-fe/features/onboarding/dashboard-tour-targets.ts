import { useMobileShellStore } from "@/stores/mobile-shell-store";
import { useOnboardingStore } from "@/stores/onboarding-store";
import { useSidebarStore } from "@/stores/sidebar-store";

const TREASURY_SELECTOR_TRIGGER_ID = "dashboard-step5";

/** 0-indexed dashboard tour steps that live in the mobile Menu sheet. */
export const DASHBOARD_TOUR_MENU_STEPS = [1, 2, 3] as const;

/** 0-indexed dashboard tour step that lives in the treasury selector / sheet. */
export const DASHBOARD_TOUR_TREASURY_STEP = 4;

export const DASHBOARD_TOUR_SURFACE_DELAY_MS = 400;

export type DashboardTourSurface = "page" | "menu" | "treasury";

const menuSteps = new Set<number>(DASHBOARD_TOUR_MENU_STEPS);

export function dashboardTourSurface(stepIndex: number): DashboardTourSurface {
    if (menuSteps.has(stepIndex)) return "menu";
    if (stepIndex === DASHBOARD_TOUR_TREASURY_STEP) return "treasury";
    return "page";
}

export type DashboardTourSide = "bottom" | "right" | "top-left" | "top-right";

/** On small screens, pin Send to the tile's left and Swap to the tile's right. */
export function dashboardTourStepSide(
    stepIndex: number,
    mobile = isTourMobileViewport(),
): DashboardTourSide {
    if (stepIndex === 0) return "bottom";
    if (!mobile)
        return stepIndex === DASHBOARD_TOUR_TREASURY_STEP
            ? "top-left"
            : "right";
    if (stepIndex === 2) return "top-right";
    return "top-left";
}

export const DASHBOARD_TOUR_SELECTOR_RETRY = {
    selectorRetryAttempts: 20,
    selectorRetryDelay: 100,
} as const;

export function isTourMobileViewport() {
    return typeof window !== "undefined" && window.innerWidth < 1024;
}

export const CREATE_TREASURY_TARGET_ID = "dashboard-step5-create-treasury";
export const CREATE_TREASURY_TARGET_ATTR = "data-tour-create-treasury";

/** Keep a single tour ID on the Create button that is actually on screen. */
export function markVisibleCreateTreasuryTarget() {
    if (typeof document === "undefined") return false;

    const nodes = document.querySelectorAll(`[${CREATE_TREASURY_TARGET_ATTR}]`);
    const visible = Array.from(nodes).filter((node) =>
        isElementVisibleInViewport(node, 8),
    );
    for (const node of nodes) {
        node.removeAttribute("id");
    }
    // The open sheet/dropdown portal is last in the DOM when both exist.
    const target = visible.at(-1);
    target?.setAttribute("id", CREATE_TREASURY_TARGET_ID);
    return !!target;
}

export function isRectVisibleInViewport(
    rect: {
        top: number;
        bottom: number;
        left: number;
        right: number;
        width: number;
        height: number;
    },
    viewport: { width: number; height: number },
    minVisiblePx = 1,
) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    const visibleTop = Math.max(rect.top, 0);
    const visibleBottom = Math.min(rect.bottom, viewport.height);
    const visibleLeft = Math.max(rect.left, 0);
    const visibleRight = Math.min(rect.right, viewport.width);
    return (
        visibleBottom - visibleTop >= minVisiblePx &&
        visibleRight - visibleLeft > 0
    );
}

export function isElementVisibleInViewport(
    el: Element,
    minVisiblePx = 1,
): boolean {
    return isRectVisibleInViewport(
        el.getBoundingClientRect(),
        { width: window.innerWidth, height: window.innerHeight },
        minVisiblePx,
    );
}

export function waitForVisibleTourTarget(
    id: string,
    timeoutMs = 2000,
): Promise<boolean> {
    if (typeof document === "undefined") return Promise.resolve(false);

    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (id === CREATE_TREASURY_TARGET_ID) {
                markVisibleCreateTreasuryTarget();
            }
            const el = document.getElementById(id);
            if (el && isElementVisibleInViewport(el)) {
                resolve(true);
                return;
            }
            if (Date.now() - started >= timeoutMs) {
                resolve(false);
                return;
            }
            requestAnimationFrame(tick);
        };
        tick();
    });
}

function scrollableAncestor(el: HTMLElement): HTMLElement | null {
    let node: HTMLElement | null = el.parentElement;
    while (
        node &&
        node !== document.body &&
        node !== document.documentElement
    ) {
        const style = window.getComputedStyle(node);
        const canScrollY =
            (style.overflowY === "auto" || style.overflowY === "scroll") &&
            node.scrollHeight > node.clientHeight + 1;
        if (canScrollY) return node;
        node = node.parentElement;
    }
    return null;
}

function scrollCreateTreasuryIntoView() {
    const el = document.getElementById(CREATE_TREASURY_TARGET_ID);
    if (!el || isElementVisibleInViewport(el)) return;

    const scroller = scrollableAncestor(el);
    if (scroller) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
}

function revealCreateTreasuryTarget() {
    markVisibleCreateTreasuryTarget();
    scrollCreateTreasuryIntoView();
}

function scheduleCreateTreasuryReveal() {
    setTimeout(revealCreateTreasuryTarget, 50);
    setTimeout(revealCreateTreasuryTarget, 200);
}

function setTreasurySelectorOpen(open: boolean) {
    const trigger = document.getElementById(TREASURY_SELECTOR_TRIGGER_ID);
    if (!trigger) return;

    const isOpen = trigger.getAttribute("data-state") === "open";
    if (isOpen === open) return;

    // Closing is blocked while the tour locks outside clicks, so lift the lock
    // for this controlled toggle.
    const { lockSelectOutside, setLockSelectOutside } =
        useOnboardingStore.getState();
    if (!open && lockSelectOutside) {
        setLockSelectOutside(false);
        trigger.click();
        // Re-lock after Radix applies the close; doing it in the same tick
        // lets onOpenChange see the lock and keep the dropdown open.
        requestAnimationFrame(() => setLockSelectOutside(true));
        return;
    }

    trigger.click();
}

/**
 * Opens the surface the given dashboard tour step needs (mobile menu, treasury
 * sheet, or desktop treasury dropdown) so nextstepjs can find its selector.
 */
export function prepareDashboardTourStep(stepIndex: number) {
    const { openSheet, closeSheet } = useMobileShellStore.getState();

    const surface = dashboardTourSurface(stepIndex);

    if (!isTourMobileViewport()) {
        closeSheet();
        if (surface !== "page") {
            useSidebarStore.getState().setSidebarOpen(true);
        }
        setTreasurySelectorOpen(surface === "treasury");
        if (surface === "treasury") {
            scheduleCreateTreasuryReveal();
        }
        return;
    }

    if (surface === "menu") {
        openSheet("menu");
        return;
    }

    if (surface === "treasury") {
        openSheet("treasury");
        scheduleCreateTreasuryReveal();
        return;
    }

    closeSheet();
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
    if (!isTourMobileViewport()) {
        setTreasurySelectorOpen(false);
    }
}
