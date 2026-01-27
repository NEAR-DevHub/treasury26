"use client";

import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/modal";
import { Button } from "@/components/button";
import { Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormMessage } from "@/components/ui/form";

interface ExchangeSettingsModalProps {
  slippageTolerance: number;
  onSlippageChange: (value: number) => void;
}

const SLIPPAGE_PRESETS = [0.1, 0.5, 1.0];

const settingsFormSchema = z.object({
  slippageTolerance: z
    .number()
    .refine((val) => val === 0 || (val >= 0.01 && val <= 100), {
      message: "Slippage must be between 0.01% and 100%",
    }),
  isCustom: z.boolean(),
});

type SettingsFormValues = z.infer<typeof settingsFormSchema>;

export function ExchangeSettingsModal({
  slippageTolerance,
  onSlippageChange,
}: ExchangeSettingsModalProps) {
  const [isOpen, setIsOpen] = useState(false);

  const form = useForm<SettingsFormValues>({
    resolver: zodResolver(settingsFormSchema),
    defaultValues: {
      slippageTolerance,
      isCustom: !SLIPPAGE_PRESETS.includes(slippageTolerance),
    },
  });

  const isCustom = form.watch("isCustom");
  const currentSlippage = form.watch("slippageTolerance");

  const handleSlippagePreset = (value: number) => {
    form.setValue("slippageTolerance", value);
    form.setValue("isCustom", false);
    form.clearErrors("slippageTolerance");
  };

  const handleCustomClick = () => {
    form.setValue("isCustom", true);
  };

  const onSubmit = (data: SettingsFormValues) => {
    if (data.slippageTolerance === 0) {
      form.setError("slippageTolerance", {
        message: "Please enter a slippage tolerance",
      });
      return;
    }
    onSlippageChange(data.slippageTolerance);
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          className="flex items-center gap-2 border-2"
          type="button"
        >
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Exchange Settings</DialogTitle>
        </DialogHeader>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 py-2">
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-semibold">Slippage Tolerance</h3>

              <div className="flex gap-2">
                {SLIPPAGE_PRESETS.map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => handleSlippagePreset(preset)}
                    className={cn(
                      "flex-1 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors",
                      !isCustom && currentSlippage === preset
                        ? "border border-general-unofficial-border-5 bg-general-secondary text-foreground"
                        : "border border-general-unofficial-border-3 bg-general-unofficial-outline text-foreground"
                    )}
                  >
                    {preset}%
                  </button>
                ))}
                <button
                  type="button"
                  onClick={handleCustomClick}
                  className={cn(
                    "flex-1 px-3 py-2.5 text-sm font-medium rounded-lg transition-colors",
                    isCustom
                      ? "border border-general-unofficial-border-5 bg-general-secondary text-foreground"
                      : "border border-general-unofficial-border-3 bg-general-unofficial-outline text-foreground"
                  )}
                >
                  Custom
                </button>
              </div>

              {isCustom && (
                <FormField
                  control={form.control}
                  name="slippageTolerance"
                  render={({ field, fieldState }) => (
                    <div className="relative">
                      <input
                        type="number"
                        value={field.value || ""}
                        onChange={(e) => {
                          const value = e.target.value.replace(/^0+(?=\d)/, "");
                          if (value === "") {
                            field.onChange(0);
                          } else {
                            field.onChange(parseFloat(value));
                          }
                        }}
                        placeholder="ex: 2%"
                        step="0.01"
                        min="0.01"
                        max="100"
                        className="w-full px-4 py-3 text-sm bg-background border rounded-lg outline-none focus:ring-2 focus:ring-ring placeholder:text-muted-foreground"
                      />
                      {fieldState.error && (
                        <p className="text-xs text-destructive mt-1.5">
                          {fieldState.error.message}
                        </p>
                      )}
                    </div>
                  )}
                />
              )}

              <p className="text-sm text-muted-foreground mt-2">
                If the price changes by more than this percentage, the transaction will be cancelled to protect your funds.
              </p>
            </div>

            <Button
              type="submit"
              className="w-full h-12 font-medium bg-foreground text-background hover:bg-foreground/90 mt-5"
            >
              Save
            </Button>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
