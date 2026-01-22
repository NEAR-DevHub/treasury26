"use client"

import { LineChart, Line, XAxis, YAxis } from 'recharts';
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
}

const chartConfig = {
    usdValue: {
        label: "USD Value",
        color: "var(--color-foreground)",
    },
    balanceValue: {
        label: "Token Balance",
        color: "var(--color-foreground)",
    },
} satisfies ChartConfig;

export default function BalanceChart({ data = [] }: BalanceChartProps) {
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
            <LineChart data={data}>
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
                            if (name === 'usdValue') {
                                return `$${num.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                })}`;
                            } else {
                                return num.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 6
                                });
                            }
                        }}
                    />}
                />
                <Line
                    type="monotone"
                    dataKey="usdValue"
                    yAxisId="usd"
                    stroke="var(--color-foreground)"
                    strokeWidth={2}
                    dot={false}
                    activeDot={{
                        r: 5,
                        fill: "var(--color-foreground)",
                        stroke: "white",
                        strokeWidth: 2
                    }}
                />
                <Line
                    type="monotone"
                    dataKey="balanceValue"
                    yAxisId="balance"
                    stroke="var(--color-foreground)"
                    strokeWidth={2}
                    strokeDasharray="5 5"
                    dot={false}
                    activeDot={{
                        r: 5,
                        fill: "var(--color-foreground)",
                        stroke: "white",
                        strokeWidth: 2
                    }}
                />
            </LineChart>
        </ChartContainer>
    );
}
