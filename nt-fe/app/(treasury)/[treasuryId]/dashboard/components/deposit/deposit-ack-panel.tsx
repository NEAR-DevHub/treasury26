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
            <div className="space-y-4 rounded-2xl border border-general-border bg-card p-4">
                <div>
                    <h3 className="text-xl font-semibold leading-7 tracking-[-0.03125rem] text-general-foreground">
                        {title}
                    </h3>
                    {subtitle && (
                        <p className="mt-1 text-base font-medium leading-[120%] text-muted-foreground">
                            {subtitle}
                        </p>
                    )}
                </div>
                <div className="space-y-3">
                    {items.map((item) => (
                        <div key={item.id} className="flex items-start gap-2">
                            <DepositNoticeIcon tone={item.tone} />
                            <div className="min-w-0">
                                <div className="text-sm font-semibold leading-[150%] text-general-foreground">
                                    {item.content}
                                </div>
                                {item.subtext && (
                                    <p className="mt-0.5 text-sm font-medium leading-[150%] text-general-secondary-foreground">
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
                        className="mt-0.5 border border-general-unofficial-border-3 bg-muted shadow-none dark:bg-muted data-[state=unchecked]:border-general-unofficial-border-3 data-[state=unchecked]:bg-muted"
                        data-testid="deposit-ack-checkbox"
                    />
                    <span className="text-sm font-semibold leading-[150%] text-general-foreground">
                        {checkboxLabel}
                    </span>
                </label>
            </div>

            <Button
                type="button"
                onClick={onCta}
                disabled={!checked || controlsDisabled || ctaLoading}
                data-testid="deposit-ack-cta"
                className="h-11 w-full rounded-2xl"
            >
                {ctaLoading ? "…" : ctaLabel}
            </Button>
        </div>
    );
}
