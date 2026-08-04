"use client";

import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";
import { Button } from "@/components/button";
import { Label } from "@/components/ui/label";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormControl, FormItem } from "@/components/ui/form";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { getTimezones, type Timezone } from "@/lib/api";
import { TimezonePicker } from "./timezone-picker";

const preferencesSchema = z.object({
    timeFormat: z.enum(["12", "24"]),
    autoTimezone: z.boolean(),
    timezone: z
        .object({
            utc: z.string(),
            value: z.string(),
            name: z.string(),
        })
        .nullable(),
});

type PreferencesFormValues = z.infer<typeof preferencesSchema>;

const PREFERENCES_STORAGE_KEY = "treasury-timezone-preferences";

export function PreferencesTab() {
    const t = useTranslations("settings.preferences");
    const [isMounted, setIsMounted] = useState(false);
    const [timezones, setTimezones] = useState<Timezone[]>([]);
    const [isLoadingTimezones, setIsLoadingTimezones] = useState(true);

    // Load preferences from localStorage
    const loadPreferences = (): PreferencesFormValues => {
        if (typeof window === "undefined") {
            return {
                timeFormat: "12",
                autoTimezone: true,
                timezone: null,
            };
        }

        try {
            const stored = localStorage.getItem(PREFERENCES_STORAGE_KEY);
            if (stored) {
                return JSON.parse(stored);
            }
        } catch (error) {
            console.error("Failed to load preferences:", error);
        }

        // Default to auto-detect timezone if no preferences stored
        return {
            timeFormat: "12",
            autoTimezone: true,
            timezone: null,
        };
    };

    const form = useForm<PreferencesFormValues>({
        resolver: zodResolver(preferencesSchema),
        defaultValues: loadPreferences(),
    });

    // Set mounted state
    useEffect(() => {
        setIsMounted(true);
    }, []);

    // Fetch timezones from API
    useEffect(() => {
        const fetchTimezones = async () => {
            setIsLoadingTimezones(true);
            try {
                const data = await getTimezones();
                setTimezones(data);
            } catch (error) {
                console.error("Error fetching timezones:", error);
                toast.error(t("loadFailed"));
            } finally {
                setIsLoadingTimezones(false);
            }
        };
        fetchTimezones();
    }, []);

    // Reset form with loaded preferences after mount
    useEffect(() => {
        if (isMounted) {
            form.reset(loadPreferences());
        }
    }, [isMounted, form]);

    // Detect user's timezone based on browser offset
    const detectUserTimezone = () => {
        if (timezones.length === 0) return;

        try {
            const d = new Date();
            const offsetMinutes = d.getTimezoneOffset();

            // Convert offset to hours (offset is negative for positive timezones)
            const offsetHours = -offsetMinutes / 60;

            // Find timezone that matches this offset
            const matchingTimezone = timezones.find((tz) => {
                // Parse UTC offset from timezone string like "UTC-11:00"
                const utcMatch = tz.utc?.match(/UTC([+-]\d{1,2}):?(\d{2})?/);
                if (utcMatch) {
                    const sign = utcMatch[1].charAt(0) === "+" ? 1 : -1;
                    const hours = parseInt(utcMatch[1].substring(1));
                    const minutes = utcMatch[2] ? parseInt(utcMatch[2]) : 0;
                    const totalOffset = sign * (hours + minutes / 60);
                    return Math.abs(totalOffset - offsetHours) < 0.1; // Allow small tolerance
                }
                return false;
            });

            if (matchingTimezone) {
                form.setValue("timezone", matchingTimezone, {
                    shouldDirty: true,
                });
            } else {
                // Fallback to UTC if no match found
                const utcTimezone =
                    timezones.find((tz) => tz.name === "UTC") || timezones[0];
                if (utcTimezone) {
                    form.setValue("timezone", utcTimezone, {
                        shouldDirty: true,
                    });
                }
            }
        } catch (error) {
            console.error("Failed to detect timezone:", error);
            // Fallback to UTC
            const utcTimezone =
                timezones.find((tz) => tz.name === "UTC") || timezones[0];
            if (utcTimezone) {
                form.setValue("timezone", utcTimezone, { shouldDirty: true });
            }
        }
    };

    // Auto-detect timezone when autoTimezone is enabled
    const autoTimezone = form.watch("autoTimezone");
    const selectedTimezone = form.watch("timezone");

    useEffect(() => {
        if (
            autoTimezone &&
            !selectedTimezone &&
            isMounted &&
            timezones.length > 0
        ) {
            detectUserTimezone();
        }
    }, [autoTimezone, isMounted, timezones]);

    const onSubmit = (data: PreferencesFormValues) => {
        try {
            localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(data));
            form.reset(data); // Reset form state to mark as unchanged
            toast.success(t("savedToast"));
        } catch (error) {
            console.error("Failed to save preferences:", error);
            toast.error(t("saveFailed"));
        }
    };

    const handleAutoTimezoneToggle = (checked: boolean) => {
        form.setValue("autoTimezone", checked, { shouldDirty: true });
        if (checked) {
            detectUserTimezone();
        }
    };

    if (!isMounted) {
        return null; // Prevent hydration mismatch
    }

    return (
        <Form {...form}>
            <form
                onSubmit={form.handleSubmit(onSubmit)}
                className="flex flex-col gap-6"
            >
                <PageCard>
                    <div>
                        <h3 className="text-lg font-semibold">
                            {t("timeZone")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("timeZoneDescription")}
                        </p>
                    </div>

                    {/* Time Format */}
                    <div className="space-y-2">
                        <Label>{t("timeFormat")}</Label>
                        <FormField
                            control={form.control}
                            name="timeFormat"
                            render={({ field }) => (
                                <FormItem>
                                    <FormControl>
                                        <Select
                                            value={field.value}
                                            onValueChange={field.onChange}
                                        >
                                            <SelectTrigger className="w-full">
                                                <SelectValue />
                                            </SelectTrigger>
                                            <SelectContent>
                                                <SelectItem value="12">
                                                    {t("hour12")}
                                                </SelectItem>
                                                <SelectItem value="24">
                                                    {t("hour24")}
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </FormControl>
                                </FormItem>
                            )}
                        />
                    </div>

                    {/* Auto Timezone Toggle */}
                    <FormField
                        control={form.control}
                        name="autoTimezone"
                        render={({ field }) => (
                            <FormItem>
                                <div className="flex items-center gap-2">
                                    <FormControl>
                                        <Switch
                                            checked={field.value}
                                            onCheckedChange={
                                                handleAutoTimezoneToggle
                                            }
                                        />
                                    </FormControl>
                                    <Label
                                        className="cursor-pointer"
                                        onClick={() =>
                                            handleAutoTimezoneToggle(
                                                !field.value,
                                            )
                                        }
                                    >
                                        {t("autoTimezone")}
                                    </Label>
                                </div>
                            </FormItem>
                        )}
                    />

                    <div className="space-y-2">
                        <Label>{t("timezone")}</Label>
                        <FormField
                            control={form.control}
                            name="timezone"
                            render={({ field }) => (
                                <FormItem>
                                    <FormControl>
                                        <TimezonePicker
                                            value={field.value}
                                            timezones={timezones}
                                            isLoading={isLoadingTimezones}
                                            disabled={
                                                autoTimezone ||
                                                isLoadingTimezones
                                            }
                                            onChange={field.onChange}
                                        />
                                    </FormControl>
                                </FormItem>
                            )}
                        />
                    </div>
                </PageCard>

                <div className="rounded-lg border bg-card p-0 overflow-hidden">
                    <Button
                        type="submit"
                        className="w-full"
                        disabled={!form.formState.isDirty}
                    >
                        {t("save")}
                    </Button>
                </div>
            </form>
        </Form>
    );
}
