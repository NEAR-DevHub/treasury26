"use client";

import { LineChart, Line, XAxis, YAxis, Area, AreaChart } from "recharts";
import { useTranslations } from "next-intl";
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig,
} from "@/components/ui/chart";
import { formatCurrencyWithSubCent } from "@/lib/utils";
import { ChartSpline } from "lucide-react";
import { EmptyState } from "@/components/empty-state";

interface ChartDataPoint {
    name: string;
    fullDate?: string;
    usdValue?: number;
    balanceValue?: number;
}

type TimePeriod = "1W" | "1M" | "3M" | "1Y";

interface BalanceChartProps {
    data?: ChartDataPoint[];
    symbol?: string;
    timePeriod?: TimePeriod;
    onMouseEnter?: () => void;
    onMouseLeave?: () => void;
}

export default function BalanceChart({
    data = [],
    symbol,
    timePeriod,
    onMouseEnter,
    onMouseLeave,
}: BalanceChartProps) {
    const t = useTranslations("balanceChart");
    const chartConfig = {
        usdValue: {
            label: t("usdValue"),
            color: "var(--color-foreground)",
        },
        balanceValue: {
            label: t("tokenBalance"),
            color: "var(--muted-foreground)",
        },
    } satisfies ChartConfig;
    if (data.length === 0) {
        return (
            <div className="h-[180px]">
                <EmptyState
                    icon={ChartSpline}
                    title={t("emptyTitle")}
                    description={t("emptyDescription")}
                />
            </div>
        );
    }

    const averageUSDValue =
        data.reduce((acc, item) => acc + (item.usdValue || 0), 0) / data.length;
    const averageBalanceValue =
        data.reduce((acc, item) => acc + (item.balanceValue || 0), 0) /
        data.length;

    // Calculate optimal tick interval based on time period.
    // The interval value tells Recharts how many ticks to skip between
    // visible labels (0 = show every label, 6 = show every 7th label).
    const isMobile = typeof window !== "undefined" && window.innerWidth < 768;

    const calculateInterval = (length: number, period?: TimePeriod): number => {
        if (period) {
            switch (period) {
                case "1W":
                    // 7 daily points: show every other on mobile (3-4 labels), all on desktop
                    return isMobile ? 1 : 0;
                case "1M":
                    // 30 daily points: ~5 labels on mobile, ~8 on desktop
                    return isMobile ? 6 : 3;
                case "3M":
                case "1Y":
                    return 0; // handled by explicit ticks below
            }
        }
        // Fallback for unknown period
        if (length <= 8) return 0;
        if (length <= 15) return 1;
        return Math.floor(length / 7);
    };

    const tickInterval = calculateInterval(data.length, timePeriod);

    // For 3M and 1Y, use explicit ticks to control label density.
    // 3M: one label per month (deduplicated from 90 daily points).
    // 1Y: unique months, then interval controls density (quarterly/semi-annual).
    const explicitTicks = (() => {
        if (timePeriod === "3M" || timePeriod === "1Y") {
            const seen = new Set<string>();
            return data
                .map((d) => d.name)
                .filter((name) => {
                    if (seen.has(name)) return false;
                    seen.add(name);
                    return true;
                });
        }
        return undefined;
    })();

    // For 1Y unique month ticks (~13), use interval to control density:
    // Desktop: every 3rd month ≈ quarterly (4-5 labels)
    // Mobile: every 6th month ≈ semi-annual (2-3 labels)
    const explicitTickInterval = timePeriod === "1Y" ? (isMobile ? 5 : 2) : 0;

    return (
        <ChartContainer
            config={chartConfig}
            className="h-56 w-full min-w-0"
            onMouseEnter={onMouseEnter}
            onMouseLeave={onMouseLeave}
        >
            <AreaChart data={data}>
                <defs>
                    <linearGradient
                        id="fillValue"
                        x1="0"
                        y1="0"
                        x2="100%"
                        y2="100%"
                    >
                        <stop
                            offset="0%"
                            stopOpacity={0.1}
                            stopColor="var(--color-chart-area-fill)"
                        />
                        <stop
                            offset="100%"
                            stopOpacity={0}
                            stopColor="var(--color-chart-area-fill)"
                        />
                    </linearGradient>
                </defs>
                <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    {...(explicitTicks
                        ? {
                              ticks: explicitTicks,
                              interval: explicitTickInterval,
                          }
                        : { interval: tickInterval })}
                    padding={{ left: 20, right: 20 }}
                />
                <YAxis
                    yAxisId="usd"
                    hide
                    domain={[
                        `dataMin - ${averageUSDValue * 0.5}`,
                        `dataMax + ${averageUSDValue * 0.5}`,
                    ]}
                />
                <YAxis
                    yAxisId="balance"
                    hide
                    orientation="right"
                    domain={[
                        `dataMin - ${averageBalanceValue * 0.5}`,
                        `dataMax + ${averageBalanceValue * 0.5}`,
                    ]}
                />
                <ChartTooltip
                    content={
                        <ChartTooltipContent
                            className="bg-card text-foreground border-border shadow-md"
                            labelFormatter={(_, payload) => {
                                const point = payload?.[0]?.payload as
                                    | ChartDataPoint
                                    | undefined;
                                return point?.fullDate ?? point?.name ?? "";
                            }}
                            formatter={(value, name) => {
                                const num = Number(value);
                                const color =
                                    name === "usdValue"
                                        ? "var(--color-foreground)"
                                        : "var(--muted-foreground)";
                                const formatted =
                                    name === "usdValue"
                                        ? formatCurrencyWithSubCent(num)
                                        : `${num.toLocaleString(undefined, {
                                              minimumFractionDigits: 2,
                                              maximumFractionDigits: 6,
                                          })}${symbol ? ` ${symbol.toUpperCase()}` : ""}`;

                                return (
                                    <>
                                        <div
                                            className="h-2.5 w-2.5 shrink-0 rounded"
                                            style={{ backgroundColor: color }}
                                        />
                                        <div className="flex flex-1 justify-between items-center leading-none">
                                            <span className="font-medium text-xs text-foreground">
                                                {formatted}
                                            </span>
                                        </div>
                                    </>
                                );
                            }}
                        />
                    }
                />
                <Area
                    type="monotone"
                    dataKey="usdValue"
                    yAxisId="usd"
                    stroke="var(--color-foreground)"
                    strokeWidth={2}
                    fill="url(#fillValue)"
                    dot={false}
                    activeDot={{
                        r: 5,
                        fill: "var(--color-foreground)",
                        stroke: "white",
                        strokeWidth: 2,
                    }}
                />
                <Area
                    type="monotone"
                    dataKey="balanceValue"
                    yAxisId="balance"
                    stroke="var(--muted-foreground)"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    fill="url(#fillValue)"
                    dot={false}
                    activeDot={{
                        r: 5,
                        fill: "var(--color-foreground)",
                        stroke: "white",
                        strokeWidth: 2,
                    }}
                />
            </AreaChart>
        </ChartContainer>
    );
}
