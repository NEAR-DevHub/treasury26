/**
 * Pins the step -> surface / step -> card side mapping for the dashboard tour.
 * Getting these wrong is what leaves a step pointing at a closed menu, or puts
 * a card half off a narrow screen, and neither shows up in a type error.
 *
 * Only the pure mapping is covered here; opening the surfaces themselves needs
 * a real DOM and belongs in the Playwright e2e.
 */
import { describe, expect, it } from "bun:test";
import {
    DASHBOARD_TOUR_MENU_STEPS,
    DASHBOARD_TOUR_TREASURY_STEP,
    dashboardTourStepSide,
    dashboardTourSurface,
    helpSupportTourStepSide,
} from "./dashboard-tour-targets";

describe("dashboardTourSurface", () => {
    it("keeps the Receive step on the page itself", () => {
        expect(dashboardTourSurface(0)).toBe("page");
    });

    it("puts the Send, Swap and Members steps in the mobile Menu sheet", () => {
        for (const stepIndex of DASHBOARD_TOUR_MENU_STEPS) {
            expect(dashboardTourSurface(stepIndex)).toBe("menu");
        }
    });

    it("puts the Create Treasury step in the treasury selector", () => {
        expect(dashboardTourSurface(DASHBOARD_TOUR_TREASURY_STEP)).toBe(
            "treasury",
        );
    });
});

describe("dashboardTourStepSide", () => {
    it("drops the Receive card below the balance card on every screen", () => {
        expect(dashboardTourStepSide(0, false)).toBe("bottom");
        expect(dashboardTourStepSide(0, true)).toBe("bottom");
    });

    it("puts nav steps beside the rail on large screens", () => {
        expect(dashboardTourStepSide(1, false)).toBe("right");
        expect(dashboardTourStepSide(2, false)).toBe("right");
        expect(dashboardTourStepSide(3, false)).toBe("right");
    });

    it("pins Send to the left edge and Swap to the right edge on small screens", () => {
        expect(dashboardTourStepSide(1, true)).toBe("top-left");
        expect(dashboardTourStepSide(2, true)).toBe("top-right");
    });

    it("sits above Create Treasury on every screen, since it is the bottom row", () => {
        expect(dashboardTourStepSide(DASHBOARD_TOUR_TREASURY_STEP, false)).toBe(
            "top-left",
        );
        expect(dashboardTourStepSide(DASHBOARD_TOUR_TREASURY_STEP, true)).toBe(
            "top-left",
        );
    });
});

describe("helpSupportTourStepSide", () => {
    it("sits beside the sidebar account row on large screens", () => {
        expect(helpSupportTourStepSide(false)).toBe("right");
    });

    it("drops below the header avatar on small screens", () => {
        expect(helpSupportTourStepSide(true)).toBe("bottom");
    });
});
