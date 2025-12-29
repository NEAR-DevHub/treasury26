"use client";

import { Slider } from "@/components/ui/slider";
import { Info, AlertTriangle } from "lucide-react";
import { InputBlock } from "./input-block";

interface ThresholdSliderProps {
    currentThreshold: number;
    memberCount: number;
    onValueChange: (value: number) => void;
    disabled?: boolean;
}

export function ThresholdSlider({
    currentThreshold,
    memberCount,
    onValueChange,
    disabled = false,
}: ThresholdSliderProps) {
    let array = memberCount === 1 ? [0, 1] : Array.from({ length: memberCount }, (_, i) => i + 1);

    return (
        <div className="space-y-2">
            <InputBlock invalid={false}>
                <div className="flex items-center justify-between text-sm mb-2">
                    {array.map((num) => (
                        <span
                            key={num}
                            className={
                                num === currentThreshold
                                    ? "font-semibold text-foreground"
                                    : "text-muted-foreground"
                            }
                        >
                            {num}
                        </span>
                    ))}
                </div>

                <Slider
                    value={[currentThreshold]}
                    onValueChange={(value) => {
                        if (value[0] > 0) {
                            onValueChange(value[0]);
                        }
                    }}
                    min={array[0]}
                    max={array[array.length - 1]}

                    step={1}
                    className="w-full"
                    disabled={disabled}
                />
            </InputBlock>

            {/* Warning banner - show when threshold is 1 */}
            {currentThreshold === 1 && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-yellow-50 dark:bg-yellow-950/20 p-3 border border-yellow-200 dark:border-yellow-900">
                    <AlertTriangle className="h-4 w-4 text-yellow-600 dark:text-yellow-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-yellow-600 dark:text-yellow-400">
                        A 1-of-{memberCount} threshold means any single member can execute
                        transactions. This reduces security.
                    </p>
                </div>
            )}

            {/* Info banner - only show if threshold is between 1 and less than total */}
            {currentThreshold > 1 && currentThreshold < memberCount && (
                <div className="mt-3 flex items-start gap-2 rounded-lg bg-blue-50 dark:bg-blue-950/20 p-3 border border-blue-200 dark:border-blue-900">
                    <Info className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                    <p className="text-sm text-blue-600 dark:text-blue-400">
                        A {currentThreshold}-of-{memberCount} threshold provides a good
                        balance between security and operational flexibility.
                    </p>
                </div>
            )}
        </div>
    );
}
