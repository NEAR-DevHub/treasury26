import { describe, expect, it } from "bun:test";
import {
    dashboardTourStepSide,
    dashboardTourSurface,
    isRectVisibleInViewport,
} from "./dashboard-tour-targets";

describe("dashboardTourSurface", () => {
    it("keeps the Receive step on the page", () => {
        expect(dashboardTourSurface(0)).toBe("page");
    });

    it("puts Send, Swap, and Members in the mobile menu", () => {
        expect(dashboardTourSurface(1)).toBe("menu");
        expect(dashboardTourSurface(2)).toBe("menu");
        expect(dashboardTourSurface(3)).toBe("menu");
    });

    it("puts Create Treasury in the treasury sheet", () => {
        expect(dashboardTourSurface(4)).toBe("treasury");
    });
});

describe("dashboardTourStepSide", () => {
    it("left-aligns Send and right-aligns Swap on small screens", () => {
        expect(dashboardTourStepSide(0, true)).toBe("bottom");
        expect(dashboardTourStepSide(1, true)).toBe("top-left");
        expect(dashboardTourStepSide(2, true)).toBe("top-right");
        expect(dashboardTourStepSide(3, true)).toBe("top-left");
        expect(dashboardTourStepSide(4, true)).toBe("top-left");
    });

    it("keeps Send and Swap on the right of the sidebar on desktop", () => {
        expect(dashboardTourStepSide(1, false)).toBe("right");
        expect(dashboardTourStepSide(2, false)).toBe("right");
        expect(dashboardTourStepSide(3, false)).toBe("right");
        expect(dashboardTourStepSide(4, false)).toBe("top-left");
    });
});

describe("isRectVisibleInViewport", () => {
    const viewport = { width: 1280, height: 800 };

    it("accepts a control fully on screen", () => {
        expect(
            isRectVisibleInViewport(
                {
                    top: 600,
                    bottom: 640,
                    left: 16,
                    right: 220,
                    width: 204,
                    height: 40,
                },
                viewport,
            ),
        ).toBe(true);
    });

    it("rejects a zero-size or off-screen control", () => {
        expect(
            isRectVisibleInViewport(
                { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 },
                viewport,
            ),
        ).toBe(false);
        expect(
            isRectVisibleInViewport(
                {
                    top: 900,
                    bottom: 940,
                    left: 16,
                    right: 220,
                    width: 204,
                    height: 40,
                },
                viewport,
            ),
        ).toBe(false);
    });

    it("requires enough of the card to stay on screen", () => {
        expect(
            isRectVisibleInViewport(
                {
                    top: 740,
                    bottom: 940,
                    left: 240,
                    right: 500,
                    width: 260,
                    height: 200,
                },
                viewport,
                48,
            ),
        ).toBe(true);
        expect(
            isRectVisibleInViewport(
                {
                    top: 790,
                    bottom: 990,
                    left: 240,
                    right: 500,
                    width: 260,
                    height: 200,
                },
                viewport,
                48,
            ),
        ).toBe(false);
    });
});
