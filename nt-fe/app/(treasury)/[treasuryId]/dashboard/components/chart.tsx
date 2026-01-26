"use client"

import { LineChart, Line, XAxis, YAxis, Area, AreaChart } from 'recharts';
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig
} from '@/components/ui/chart';

interface ChartDataPoint {
    name: string;
    usdValue?: number;
    balanceValue?: number;
}

interface BalanceChartProps {
    data?: ChartDataPoint[];
    symbol?: string;
}

const chartConfig = {
    usdValue: {
        label: "USD Value",
        color: "var(--color-foreground)",
    },
    balanceValue: {
        label: "Token Balance",
        color: "var(--muted-foreground)",
    },
} satisfies ChartConfig;

export default function BalanceChart({ data = [], symbol }: BalanceChartProps) {
    if (data.length === 0) {
        return (
            <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
                No balance history available
            </div>
        );
    }

    const averageUSDValue = data.reduce((acc, item) => acc + (item.usdValue || 0), 0) / data.length;
    const averageBalanceValue = data.reduce((acc, item) => acc + (item.balanceValue || 0), 0) / data.length;

    // Calculate optimal interval based on data length
    // Show ~6-8 ticks for good readability
    const calculateInterval = (length: number) => {
        if (length <= 8) return 0; // Show all for small datasets
        if (length <= 15) return 1; // Every other point
        return Math.floor(length / 7); // ~7 ticks for larger datasets
    };

    const tickInterval = calculateInterval(data.length);

    return (
        <ChartContainer config={chartConfig} className='h-56'>
            <AreaChart data={data}>
                <defs>
                    <linearGradient id="fillValue" x1="0" y1="0" x2="100%" y2="100%">
                        <stop
                            offset="0%"
                            stopOpacity={0.1}
                            stopColor="rgb(2,7,6)"
                        />
                        <stop
                            offset="100%"
                            stopOpacity={0}
                            stopColor="rgb(2,7,6)"
                        />
                    </linearGradient>
                </defs>
                <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    interval={tickInterval}
                    padding={{ left: 20, right: 20 }}
                />
                <YAxis
                    yAxisId="usd"
                    hide
                    domain={[`dataMin - ${averageUSDValue * 0.5}`, `dataMax + ${averageUSDValue * 0.5}`]}
                />
                <YAxis
                    yAxisId="balance"
                    hide
                    orientation="right"
                    domain={[`dataMin - ${averageBalanceValue * 0.5}`, `dataMax + ${averageBalanceValue * 0.5}`]}
                />
                <ChartTooltip
                    content={<ChartTooltipContent
                        formatter={(value, name) => {
                            const num = Number(value);
                            const color = name === 'usdValue'
                                ? 'var(--color-foreground)'
                                : 'var(--muted-foreground)';
                            const formatted = name === 'usdValue'
                                ? `$${num.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                })}`
                                : `${num.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 6
                                })}${symbol ? ` ${symbol.toUpperCase()}` : ''}`;

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
                    />}
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
                        strokeWidth: 2
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
                        strokeWidth: 2
                    }}
                />
            </AreaChart>
        </ChartContainer>
    );
}
