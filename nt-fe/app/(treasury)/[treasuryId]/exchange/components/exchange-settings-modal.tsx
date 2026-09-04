"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { SlidersHorizontalIcon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { Button } from "@/components/button";
import { FormattedAmount } from "@/components/formatted-amount";
import { Icon } from "@/components/icon";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    mobileInsetSheetClassName,
} from "@/components/modal";
import { Form, FormField } from "@/components/ui/form";
import { decimalOrNull } from "@/lib/amount-format";
import { minimumReceivedDecimal } from "@/lib/minimum-received";
import { cn } from "@/lib/utils";

export const SLIPPAGE_PRESETS = [0.1, 0.25, 0.5, 1, 3] as const;

interface ExchangeSettingsModalProps {
    slippageTolerance: number;
    onSlippageChange: (value: number) => void;
    id?: string;
    trigger?: ReactNode;
    receiveAmount?: string | null;
    receiveSymbol?: string;
    receiveDecimals?: number;
    receivePrice?: number;
}

function buildSettingsFormSchema(messages: { slippageRange: string }) {
    return z.object({
        slippageTolerance: z
            .number()
            .refine((val) => val === 0 || (val >= 0.01 && val <= 100), {
                message: messages.slippageRange,
            }),
        isCustom: z.boolean(),
    });
}

type SettingsFormValues = z.infer<ReturnType<typeof buildSettingsFormSchema>>;

export function isSlippagePreset(value: number): boolean {
    const parsed = decimalOrNull(value);
    if (!parsed) return false;
    return SLIPPAGE_PRESETS.some((preset) => {
        const presetValue = decimalOrNull(preset);
        return !!presetValue && parsed.eq(presetValue);
    });
}

export function ExchangeSettingsModal({
    slippageTolerance,
    onSlippageChange,
    id,
    trigger,
    receiveAmount,
    receiveSymbol,
    receiveDecimals,
    receivePrice,
}: ExchangeSettingsModalProps) {
    const t = useTranslations("exchangeSettings");
    const tEx = useTranslations("exchange");
    const [isOpen, setIsOpen] = useState(false);

    const settingsFormSchema = useMemo(
        () =>
            buildSettingsFormSchema({
                slippageRange: t("slippageRange"),
            }),
        [t],
    );

    const form = useForm<SettingsFormValues>({
        resolver: zodResolver(settingsFormSchema),
        defaultValues: {
            slippageTolerance,
            isCustom: !isSlippagePreset(slippageTolerance),
        },
    });

    useEffect(() => {
        if (!isOpen) return;
        form.reset({
            slippageTolerance,
            isCustom: !isSlippagePreset(slippageTolerance),
        });
    }, [form, isOpen, slippageTolerance]);

    const isCustom = form.watch("isCustom");
    const currentSlippage = form.watch("slippageTolerance");
    const minReceived = minimumReceivedDecimal(receiveAmount, currentSlippage);

    const handleSlippagePreset = (value: number) => {
        form.setValue("slippageTolerance", value);
        form.setValue("isCustom", false);
        form.clearErrors("slippageTolerance");
    };

    const handleCustomClick = () => {
        form.setValue("isCustom", true);
        if (isSlippagePreset(currentSlippage)) {
            form.setValue("slippageTolerance", 0);
        }
    };

    const onSubmit = (data: SettingsFormValues) => {
        if (data.slippageTolerance === 0) {
            form.setError("slippageTolerance", {
                message: t("enterSlippage"),
            });
            return;
        }
        onSlippageChange(data.slippageTolerance);
        setIsOpen(false);
    };

    return (
        <Dialog open={isOpen} onOpenChange={setIsOpen}>
            <DialogTrigger asChild>
                {trigger ?? (
                    <Button
                        id={id}
                        size="icon"
                        variant="ghost"
                        type="button"
                        className="border-2"
                    >
                        <Icon icon={SlidersHorizontalIcon} />
                    </Button>
                )}
            </DialogTrigger>
            <DialogContent
                className={cn(
                    mobileInsetSheetClassName,
                    "gap-2 max-sm:gap-2 sm:max-w-md!",
                )}
            >
                <DialogHeader className="border-0">
                    <DialogTitle className="text-left">
                        {t("title")}
                    </DialogTitle>
                </DialogHeader>

                <Form {...form}>
                    <form
                        onSubmit={form.handleSubmit(onSubmit)}
                        className="flex flex-col gap-5"
                    >
                        <p className="text-sm font-medium leading-[1.3125rem] text-general-secondary-foreground">
                            {t("description")}
                        </p>

                        {receiveSymbol ? (
                            <div className="flex items-center justify-between gap-3 rounded-xl border border-general-border px-3.5 py-3">
                                <span className="text-sm text-muted-foreground">
                                    {tEx("receiveAtLeast")}
                                </span>
                                <span className="text-sm font-semibold text-foreground">
                                    {minReceived ? (
                                        <FormattedAmount
                                            kind="token"
                                            value={minReceived}
                                            symbol={receiveSymbol}
                                            tokenDecimals={receiveDecimals}
                                            unitPriceUsd={receivePrice}
                                            profile="standard"
                                            rounding="down"
                                        />
                                    ) : (
                                        "—"
                                    )}
                                </span>
                            </div>
                        ) : null}

                        <div className="grid grid-cols-3 gap-2">
                            {SLIPPAGE_PRESETS.map((preset) => {
                                const selected =
                                    !isCustom &&
                                    decimalOrNull(currentSlippage)?.eq(preset);
                                return (
                                    <button
                                        key={preset}
                                        type="button"
                                        onClick={() =>
                                            handleSlippagePreset(preset)
                                        }
                                        className={cn(
                                            "rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                                            selected
                                                ? "bg-foreground text-background"
                                                : "bg-muted text-foreground hover:bg-muted/80",
                                        )}
                                    >
                                        {preset}%
                                    </button>
                                );
                            })}
                            {isCustom ? (
                                <FormField
                                    control={form.control}
                                    name="slippageTolerance"
                                    render={({ field, fieldState }) => (
                                        <div className="relative">
                                            <input
                                                type="text"
                                                inputMode="decimal"
                                                autoFocus
                                                value={
                                                    field.value
                                                        ? String(field.value)
                                                        : ""
                                                }
                                                onChange={(e) => {
                                                    const value =
                                                        e.target.value.replace(
                                                            /[^0-9.]/g,
                                                            "",
                                                        );
                                                    if (value === "") {
                                                        field.onChange(0);
                                                        return;
                                                    }
                                                    const parsed =
                                                        Number(value);
                                                    field.onChange(
                                                        Number.isFinite(parsed)
                                                            ? parsed
                                                            : 0,
                                                    );
                                                }}
                                                placeholder={t("custom")}
                                                className={cn(
                                                    "h-full w-full rounded-xl bg-muted px-3 py-2.5 pr-8 text-sm font-medium outline-none",
                                                    fieldState.error &&
                                                        "ring-1 ring-destructive",
                                                )}
                                            />
                                            <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-sm text-muted-foreground">
                                                %
                                            </span>
                                        </div>
                                    )}
                                />
                            ) : (
                                <button
                                    type="button"
                                    onClick={handleCustomClick}
                                    className="rounded-xl bg-muted px-3 py-2.5 text-sm font-medium text-foreground hover:bg-muted/80"
                                >
                                    {t("custom")}
                                </button>
                            )}
                        </div>

                        <Button
                            type="submit"
                            className="mt-1 h-12 w-full rounded-2xl"
                        >
                            {t("save")}
                        </Button>
                    </form>
                </Form>
            </DialogContent>
        </Dialog>
    );
}
