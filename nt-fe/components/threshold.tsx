"use client";

import { Slider } from "@/components/ui/slider";
import { InputBlock } from "./input-block";
import { WarningAlert } from "./warning-alert";
import { InfoAlert } from "./info-alert";

interface ThresholdSliderProps {
    currentThreshold: number;
    originalThreshold?: number;
    memberCount: number;
    onValueChange: (value: number) => void;
    disabled?: boolean;
}

export function ThresholdSlider({
    currentThreshold,
    originalThreshold,
    memberCount,
    onValueChange,
    disabled = false,
}: ThresholdSliderProps) {
    // Show 0 in these cases to ensure visual fill:
    // 1. When memberCount is 1 or 2
    // 2. When originalThreshold (prevents labels from changing during drag)
    let array: number[];
    let sliderMin: number;
    
    const shouldShowZero = memberCount === 1 || 
                          memberCount === 2 || 
                          originalThreshold === 1 
    
    if (memberCount === 1) {
        array = [0, 1];
        sliderMin = 0;
    } else if (shouldShowZero) {
        // Include 0 to show visual progress
        array = Array.from({ length: memberCount + 1 }, (_, i) => i);
        sliderMin = 0;
    } else {
        array = Array.from({ length: memberCount }, (_, i) => i + 1);
        sliderMin = 1;
    }
    
    const sliderMax = memberCount;

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
                        // Only allow values >= 1 (prevent selecting 0)
                        if (value[0] >= 1) {
                            onValueChange(value[0]);
                        }
                    }}
                    min={sliderMin}
                    max={sliderMax}
                    step={1}
                    className="w-full"
                    disabled={disabled || memberCount === 1}
                    showFullTrack={true}
                />
            </InputBlock>

            {/* Warning banner - show when threshold is 1 */}
            {currentThreshold === 1 && (
                <WarningAlert 
                    message={`A 1-of-${memberCount} threshold means any single member can execute transactions. This reduces security.`}
                    className="mt-3"
                />
            )}

            {/* Info banner - only show if threshold is between 1 and less than total */}
            {currentThreshold > 1 && currentThreshold < memberCount && (
                <InfoAlert
                    message={`A ${currentThreshold}-of-${memberCount} threshold provides a good balance between security and operational flexibility.`}
                    className="mt-3"
                />
            )}
        </div>
    );
}
