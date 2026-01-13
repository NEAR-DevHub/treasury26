"use client"

import { AreaChart, Area, XAxis, YAxis } from 'recharts';
import {
    ChartContainer,
    ChartTooltip,
    ChartTooltipContent,
    type ChartConfig
} from '@/components/ui/chart';

interface ChartDataPoint {
    name: string;
    value: number;
}

interface BalanceChartProps {
    data?: ChartDataPoint[];
    showUSD?: boolean;
}

const chartConfig = {
    value: {
        label: "Balance",
        color: "var(--color-chart-1)",
    },
} satisfies ChartConfig;

export default function BalanceChart({ data = [], showUSD = true }: BalanceChartProps) {
    if (data.length === 0) {
        return (
            <div className="h-56 flex items-center justify-center text-sm text-muted-foreground">
                No balance history available
            </div>
        );
    }
    
    const averageValue = data.reduce((acc, item) => acc + item.value, 0) / data.length;
    
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
                    <linearGradient id="fillValue" x1="0" y1="0" x2="0" y2="1">
                        <stop
                            offset="5%"
                            stopOpacity={0.3}
                            stopColor="var(--color-foreground)"
                        />
                        <stop
                            offset="95%"
                            stopOpacity={0.05}
                            stopColor="var(--color-foreground)"
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
                    hide
                    domain={[`dataMin - ${averageValue * 0.5}`, `dataMax + ${averageValue * 0.5}`]}
                />
                <ChartTooltip
                    content={<ChartTooltipContent 
                        formatter={(value) => {
                            const num = Number(value);
                            if (showUSD) {
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
                <Area
                    type="monotone"
                    dataKey="value"
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
            </AreaChart>
        </ChartContainer>
    );
}
