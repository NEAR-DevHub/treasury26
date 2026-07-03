import { test, expect, Page, Route } from "@playwright/test";
import ROMAKQA_ASSETS from "./fixtures/romakqa-assets.json";
import CHART_1W from "./fixtures/romakqa-chart-1w.json";
import CHART_1M from "./fixtures/romakqa-chart-1m.json";
import CHART_3M from "./fixtures/romakqa-chart-3m.json";
import CHART_1Y from "./fixtures/romakqa-chart-1y.json";

/**
 * Reproduces GitHub issue #228:
 * Dashboard chart shows incorrect data aggregation for 3M and 1Y periods.
 *
 * The chart x-axis labels appear at ~2-week intervals for 3M (should cover
 * full 3 months) and ~2-month intervals for 1Y (should cover full year).
 * Uses real fixture data from romakqatesting.sputnik-dao.near.
 *
 * @see https://github.com/NEAR-DevHub/treasury26/issues/228
 */

const TREASURY_ID = "romakqatesting.sputnik-dao.near";
const DASHBOARD_URL = `/${TREASURY_ID}`;

test.use({ locale: "en-US" });

const MONITORED_ACCOUNTS_RESPONSE = {
    accountId: TREASURY_ID,
    enabled: true,
    lastSyncedAt: "2026-02-21T15:34:01.949124Z",
    createdAt: "2026-01-15T00:00:00Z",
    updatedAt: "2026-02-21T15:34:01.949124Z",
    exportCredits: 10,
    batchPaymentCredits: 100,
    planType: "pro",
    creditsResetAt: "2026-03-01T00:00:00Z",
    dirtyAt: null,
    isNewRegistration: false,
};

// Expected data point counts for each period
const EXPECTED_POINTS: Record<string, number> = {
    "1W": 7,
    "1M": 30,
    "3M": 90,
    "1Y": 53,
};

// Maximum days between consecutive x-axis labels for each period.
const MAX_LABEL_GAP_DAYS: Record<string, number> = {
    "1W": 2, // daily labels, gap ≤ 2 days
    "1M": 7, // daily labels, gap ≤ 7 days
    "3M": 35, // monthly labels, gap ≤ ~35 days
    "1Y": 95, // quarterly labels (Mar→Jun→Sep→Dec), gap ≤ ~95 days
};

// Minimum expected time span coverage (in days) for each period.
const MIN_SPAN_DAYS: Record<string, number> = {
    "1W": 5,
    "1M": 25,
    "3M": 55, // ~3 month names (e.g. Nov→Feb parsed as month 1st)
    "1Y": 250, // 4 quarterly labels span ~9 months (Mar→Dec)
};

async function setupMocks(page: Page) {
    let currentPeriod = "1W";

    await page.route("**/api/monitored-accounts", async (route: Route) => {
        const method = route.request().method();
        if (method === "POST") {
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(MONITORED_ACCOUNTS_RESPONSE),
            });
        } else if (method === "OPTIONS") {
            await route.fulfill({ status: 200 });
        } else {
            await route.continue();
        }
    });

    await page.route("**/api/user/assets*", async (route: Route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(ROMAKQA_ASSETS),
        });
    });

    await page.route("**/api/balance-history/chart*", async (route: Route) => {
        const url = new URL(route.request().url());
        const interval = url.searchParams.get("interval");
        const startTime = url.searchParams.get("startTime");
        const endTime = url.searchParams.get("endTime");

        // Determine which fixture to use based on interval and time range
        let fixture: object;
        if (interval === "weekly") {
            fixture = CHART_1Y;
            currentPeriod = "1Y";
        } else if (interval === "daily" && startTime && endTime) {
            const start = new Date(startTime);
            const end = new Date(endTime);
            const daysDiff =
                (end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24);

            if (daysDiff > 60) {
                fixture = CHART_3M;
                currentPeriod = "3M";
            } else if (daysDiff > 14) {
                fixture = CHART_1M;
                currentPeriod = "1M";
            } else {
                fixture = CHART_1W;
                currentPeriod = "1W";
            }
        } else {
            fixture = CHART_1W;
        }

        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify(fixture),
        });
    });

    await page.route("**/api/recent-activity*", async (route: Route) => {
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ data: [], total: 0 }),
        });
    });

    return { getCurrentPeriod: () => currentPeriod };
}

/**
 * Select a time period from the desktop dropdown. The trigger shows the
 * currently selected period; the other options live in a portaled menu that
 * must be opened first.
 */
async function selectDesktopPeriod(page: Page, period: string) {
    await page.getByTestId("chart-period-trigger").click();
    await page.getByTestId(`chart-period-option-${period}`).click();
}

/**
 * Collect x-axis tick labels from the rendered chart.
 * Returns an array of { text, left, right } for each visible tick label.
 */
async function getXAxisLabels(
    page: Page,
): Promise<Array<{ text: string; left: number; right: number }>> {
    return page.evaluate(() => {
        const xAxisGroup = document.querySelector(".recharts-xAxis");
        if (!xAxisGroup) return [];

        const ticks = xAxisGroup.querySelectorAll(
            ".recharts-cartesian-axis-tick text",
        );
        return Array.from(ticks).map((tick) => {
            const rect = tick.getBoundingClientRect();
            return {
                text: tick.textContent || "",
                left: rect.left,
                right: rect.right,
            };
        });
    });
}

/**
 * Count the number of data points rendered in the chart's area path.
 * Recharts renders one SVG path for the area, and the number of line
 * commands (L) + the initial move (M) gives the data point count.
 */
async function getChartDataPointCount(page: Page): Promise<number> {
    return page.evaluate(() => {
        // Recharts area chart renders a path with class "recharts-area-curve"
        const path = document.querySelector(
            ".recharts-area-area path, .recharts-area .recharts-area-curve",
        );
        if (!path) return 0;

        const d = path.getAttribute("d");
        if (!d) return 0;

        // Count M (moveto) + L (lineto) + C (curveto, which connects points).
        // For monotone curve type, Recharts uses C (cubic bezier) commands.
        // Each data point generates one C command (except the first which is M).
        const moveCount = (d.match(/M/g) || []).length;
        const curveCount = (d.match(/C/g) || []).length;
        const lineCount = (d.match(/L/g) || []).length;

        // Total data points = initial move + subsequent curves/lines
        return moveCount + curveCount + lineCount;
    });
}

/**
 * Parse a date label like "Nov 23", "11/23/2025", "Mar '25", or "Now"
 * into a Date object relative to a reference date.
 */
function parseLabelDate(label: string, referenceDate: Date): Date | null {
    if (label === "Now") return referenceDate;

    // "Mar '25" format (1Y)
    const yearMatch = label.match(/^([A-Z][a-z]{2}) '(\d{2})$/);
    if (yearMatch) {
        const monthStr = yearMatch[1];
        const year = 2000 + parseInt(yearMatch[2]);
        const date = new Date(`${monthStr} 1, ${year}`);
        return isNaN(date.getTime()) ? null : date;
    }

    // "Nov" format (month-only, used by 3M)
    const monthOnlyMatch = label.match(/^([A-Z][a-z]{2})$/);
    if (monthOnlyMatch) {
        const monthStr = monthOnlyMatch[1];
        let date = new Date(`${monthStr} 1, ${referenceDate.getFullYear()}`);
        if (date > referenceDate) {
            date = new Date(
                `${monthStr} 1, ${referenceDate.getFullYear() - 1}`,
            );
        }
        return isNaN(date.getTime()) ? null : date;
    }

    // "Nov 23" format (short date)
    const shortMatch = label.match(/^([A-Z][a-z]{2}) (\d{1,2})$/);
    if (shortMatch) {
        const monthStr = shortMatch[1];
        const day = parseInt(shortMatch[2]);
        // Try current year first, then previous year
        let date = new Date(
            `${monthStr} ${day}, ${referenceDate.getFullYear()}`,
        );
        if (date > referenceDate) {
            date = new Date(
                `${monthStr} ${day}, ${referenceDate.getFullYear() - 1}`,
            );
        }
        return isNaN(date.getTime()) ? null : date;
    }

    // "11/23/2025" format (full locale date)
    const fullMatch = label.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (fullMatch) {
        const date = new Date(label);
        return isNaN(date.getTime()) ? null : date;
    }

    return null;
}

// ---------- Tests ----------

test.describe("Dashboard chart time period aggregation (issue #228)", () => {
    for (const period of ["3M", "1Y"] as const) {
        test(`${period} chart should have data points covering the full period`, async ({
            page,
        }) => {
            test.setTimeout(60_000);

            await setupMocks(page);
            await page.goto(DASHBOARD_URL);

            // Wait for chart to render with default period (1W)
            const chartContainer = page.locator("[data-slot='chart']").first();
            await chartContainer
                .locator("svg")
                .first()
                .waitFor({ state: "visible", timeout: 15_000 });

            // Select the target time period via the desktop dropdown
            await selectDesktopPeriod(page, period);

            // Wait for chart to re-render with new period data
            await page.waitForTimeout(2000);

            // Collect x-axis labels
            const labels = await getXAxisLabels(page);
            expect(labels.length).toBeGreaterThan(0);

            console.log(
                `[${period}] X-axis labels (${labels.length}):`,
                labels.map((l) => l.text),
            );

            // Take a screenshot for visual verification
            await page.screenshot({
                path: `test-results/chart-period-${period.toLowerCase()}.png`,
                fullPage: false,
            });

            // Parse label dates and calculate the span
            const refDate = new Date();
            const parsedDates = labels
                .map((l) => ({
                    text: l.text,
                    date: parseLabelDate(l.text, refDate),
                }))
                .filter(
                    (l): l is { text: string; date: Date } => l.date !== null,
                );

            expect(
                parsedDates.length,
                `Should have parseable date labels for ${period}`,
            ).toBeGreaterThan(1);

            // Calculate the time span covered by labels
            const dates = parsedDates.map((l) => l.date.getTime());
            const minDate = Math.min(...dates);
            const maxDate = Math.max(...dates);
            const spanDays = (maxDate - minDate) / (1000 * 60 * 60 * 24);

            console.log(
                `[${period}] Label date span: ${spanDays.toFixed(1)} days (min expected: ${MIN_SPAN_DAYS[period]})`,
            );

            // ASSERTION: Labels should span the expected time range.
            // This is the core of the bug - for 3M, labels only cover ~74 days
            // instead of ~90 days. For 1Y, labels cover ~350 days but with
            // gaps of ~2 months between them.
            expect(
                spanDays,
                `${period} x-axis labels should span at least ${MIN_SPAN_DAYS[period]} days, but only span ${spanDays.toFixed(1)} days`,
            ).toBeGreaterThanOrEqual(MIN_SPAN_DAYS[period]);

            // Check gaps between consecutive labels
            // Exclude "Now" from gap checks: it maps to today's date, so its
            // distance from the last fixture label grows over time and would
            // cause false failures as fixture data ages.
            const sortedDates = parsedDates
                .filter((l) => l.text !== "Now")
                .map((l) => l.date.getTime())
                .sort((a, b) => a - b);

            const gaps: Array<{ days: number; from: string; to: string }> = [];
            for (let i = 1; i < sortedDates.length; i++) {
                const gapDays =
                    (sortedDates[i] - sortedDates[i - 1]) /
                    (1000 * 60 * 60 * 24);
                if (gapDays > MAX_LABEL_GAP_DAYS[period]) {
                    gaps.push({
                        days: Math.round(gapDays),
                        from: new Date(sortedDates[i - 1]).toLocaleDateString(),
                        to: new Date(sortedDates[i]).toLocaleDateString(),
                    });
                }
            }

            if (gaps.length > 0) {
                console.log(
                    `[${period}] Labels have excessive gaps (>${MAX_LABEL_GAP_DAYS[period]} days):`,
                    gaps,
                );
            }

            // ASSERTION: No gaps between consecutive labels should exceed
            // the maximum allowed for this period.
            expect(
                gaps,
                `${period} chart has ${gaps.length} label gap(s) exceeding ${MAX_LABEL_GAP_DAYS[period]} days: ${JSON.stringify(gaps)}`,
            ).toHaveLength(0);
        });
    }

    test("all periods should render the correct number of data points in the chart path", async ({
        page,
    }) => {
        test.setTimeout(90_000);

        await setupMocks(page);
        await page.goto(DASHBOARD_URL);

        const chartContainer = page.locator("[data-slot='chart']").first();
        await chartContainer
            .locator("svg")
            .first()
            .waitFor({ state: "visible", timeout: 15_000 });

        for (const period of ["1W", "1M", "3M", "1Y"] as const) {
            // Select period via the desktop dropdown
            await selectDesktopPeriod(page, period);
            await page.waitForTimeout(2000);

            // Count rendered data points in the SVG path
            const pointCount = await getChartDataPointCount(page);

            console.log(
                `[${period}] Rendered data points: ${pointCount}, expected: ~${EXPECTED_POINTS[period] + 1} (data + "Now")`,
            );

            // The chart should render approximately EXPECTED_POINTS + 1 (for "Now")
            // Allow some tolerance since Recharts may optimize the path
            const expectedMin = EXPECTED_POINTS[period];
            expect(
                pointCount,
                `${period} chart should render at least ${expectedMin} data points, but only rendered ${pointCount}`,
            ).toBeGreaterThanOrEqual(expectedMin);
        }
    });
});
