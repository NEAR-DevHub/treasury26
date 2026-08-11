"use client";

import { Button } from "@/components/button";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import {
    DepositNoticeIcon,
    type DepositNoticeTone,
} from "./deposit-notice-icon";

export type AckItemTone = Extract<DepositNoticeTone, "success" | "danger">;

export interface AckItem {
    id: string;
    tone: AckItemTone;
    content: React.ReactNode;
    subtext?: React.ReactNode;
}

interface DepositAckPanelProps {
    title: string;
    subtitle?: string;
    items: AckItem[];
    checkboxLabel: React.ReactNode;
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
    ctaLabel: string;
    onCta: () => void;
    /** Disables checkbox + CTA (e.g. slot-wide deposit pause). */
    disabled?: boolean;
    ctaDisabled?: boolean;
    ctaLoading?: boolean;
    className?: string;
}

export function DepositAckPanel({
    title,
    subtitle,
    items,
    checkboxLabel,
    checked,
    onCheckedChange,
    ctaLabel,
    onCta,
    disabled,
    ctaDisabled,
    ctaLoading,
    className,
}: DepositAckPanelProps) {
    const controlsDisabled = Boolean(disabled || ctaDisabled);

    return (
        <div className={cn("space-y-3", className)}>
            <div>
                <h3 className="font-semibold text-base">{title}</h3>
                {subtitle && <p className="text-sm mt-1">{subtitle}</p>}
            </div>
            <div className="deposit-ack-panel rounded-xl border border-transparent p-4 space-y-4">
                <div className="space-y-3">
                    {items.map((item) => (
                        <div key={item.id} className="flex gap-2 items-start">
                            <DepositNoticeIcon tone={item.tone} />
                            <div className="text-sm text-muted-foreground">
                                <div>{item.content}</div>
                                {item.subtext && (
                                    <p className="text-xs mt-0.5">
                                        {item.subtext}
                                    </p>
                                )}
                            </div>
                        </div>
                    ))}
                </div>

                <label
                    className={cn(
                        "flex gap-2.5 items-start",
                        disabled
                            ? "cursor-not-allowed opacity-50"
                            : "cursor-pointer",
                    )}
                >
                    <Checkbox
                        checked={checked}
                        disabled={disabled}
                        onCheckedChange={(value) =>
                            onCheckedChange(value === true)
                        }
                        className="mt-0.5 border border-general-unofficial-border-3 bg-muted shadow-none dark:bg-muted data-[state=unchecked]:bg-muted data-[state=unchecked]:border-general-unofficial-border-3"
                        data-testid="deposit-ack-checkbox"
                    />
                    <span className="text-sm leading-snug">
                        {checkboxLabel}
                    </span>
                </label>

                <Button
                    type="button"
                    onClick={onCta}
                    disabled={!checked || controlsDisabled || ctaLoading}
                    data-testid="deposit-ack-cta"
                    className="w-full"
                >
                    {ctaLoading ? "…" : ctaLabel}
                </Button>
            </div>
        </div>
    );
}
