"use client";

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
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Form, FormField, FormControl, FormItem } from "@/components/ui/form";
import { useEffect, useState, useMemo } from "react";
import { toast } from "sonner";
import { getTimezones, type Timezone } from "@/lib/api";
import { Search } from "lucide-react";

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
  const [isMounted, setIsMounted] = useState(false);
  const [timezones, setTimezones] = useState<Timezone[]>([]);
  const [isLoadingTimezones, setIsLoadingTimezones] = useState(true);
  const [timezoneSearch, setTimezoneSearch] = useState("");

  // Load preferences from localStorage
  const loadPreferences = (): PreferencesFormValues => {
    if (typeof window === "undefined") {
      return {
        timeFormat: "12",
        autoTimezone: false,
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

    return {
      timeFormat: "12",
      autoTimezone: false,
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
        toast.error("Failed to load timezones");
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
        form.setValue("timezone", matchingTimezone, { shouldDirty: true });
      } else {
        // Fallback to UTC if no match found
        const utcTimezone =
          timezones.find((tz) => tz.name === "UTC") || timezones[0];
        if (utcTimezone) {
          form.setValue("timezone", utcTimezone, { shouldDirty: true });
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
      toast.success("Preferences saved successfully");
    } catch (error) {
      console.error("Failed to save preferences:", error);
      toast.error("Failed to save preferences");
    }
  };

  const handleAutoTimezoneToggle = (checked: boolean) => {
    form.setValue("autoTimezone", checked, { shouldDirty: true });
    if (checked) {
      detectUserTimezone();
    }
  };

  // Filter timezones based on search
  const filteredTimezones = useMemo(() => {
    if (!timezoneSearch) return timezones;
    const searchLower = timezoneSearch.toLowerCase();
    return timezones.filter(
      (tz) =>
        tz.value.toLowerCase().includes(searchLower) ||
        tz.utc.toLowerCase().includes(searchLower) ||
        tz.name.toLowerCase().includes(searchLower),
    );
  }, [timezones, timezoneSearch]);

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
            <h3 className="text-lg font-semibold">Time Zone</h3>
            <p className="text-sm text-muted-foreground">
              Set your local time zone for accurate date and time display.
            </p>
          </div>

          {/* Time Format */}
          <div className="space-y-2">
            <Label>Time Format</Label>
            <FormField
              control={form.control}
              name="timeFormat"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Select value={field.value} onValueChange={field.onChange}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="12">12-hour (1:00 PM)</SelectItem>
                        <SelectItem value="24">24-hour (13:00)</SelectItem>
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
                      onCheckedChange={handleAutoTimezoneToggle}
                    />
                  </FormControl>
                  <Label
                    className="cursor-pointer"
                    onClick={() => handleAutoTimezoneToggle(!field.value)}
                  >
                    Set timezone automatically using your location
                  </Label>
                </div>
              </FormItem>
            )}
          />

          {/* Timezone Select */}
          <div className="space-y-2">
            <Label>Timezone</Label>
            <FormField
              control={form.control}
              name="timezone"
              render={({ field }) => (
                <FormItem>
                  <FormControl>
                    <Select
                      value={field.value?.name || ""}
                      onValueChange={(value) => {
                        const selected = timezones.find(
                          (tz) => tz.name === value,
                        );
                        field.onChange(selected);
                        setTimezoneSearch(""); // Clear search after selection
                      }}
                      onOpenChange={(open) => {
                        if (!open) setTimezoneSearch(""); // Clear search when dropdown closes
                      }}
                      disabled={autoTimezone || isLoadingTimezones}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue>
                          {isLoadingTimezones ? (
                            <span className="text-muted-foreground">
                              Loading timezones...
                            </span>
                          ) : field.value ? (
                            <span>
                              ({field.value.utc}) {field.value.value}
                            </span>
                          ) : (
                            <span className="text-muted-foreground">
                              Select Timezone
                            </span>
                          )}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <div 
                          className="flex items-center gap-2 px-2 pb-2 border-b sticky top-0 bg-popover z-10"
                          onPointerDown={(e) => e.stopPropagation()}
                        >
                          <Search className="h-4 w-4 text-muted-foreground shrink-0" />
                          <Input
                            placeholder="Search timezones..."
                            value={timezoneSearch}
                            onChange={(e) => setTimezoneSearch(e.target.value)}
                            className="h-8 border-0 focus-visible:ring-0 focus-visible:ring-offset-0"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                            autoFocus
                          />
                        </div>
                        <div className="max-h-[300px] overflow-y-auto">
                          {filteredTimezones.length > 0 ? (
                            filteredTimezones.map((tz) => (
                              <SelectItem key={tz.name} value={tz.name}>
                                ({tz.utc}) {tz.value}
                              </SelectItem>
                            ))
                          ) : (
                            <div className="py-6 text-center text-sm text-muted-foreground">
                              No timezones found
                            </div>
                          )}
                        </div>
                      </SelectContent>
                    </Select>
                  </FormControl>
                </FormItem>
              )}
            />
          </div>
        </PageCard>

        <div className="rounded-lg border bg-card p-0 overflow-hidden">
          <Button
            type="submit"
            className="w-full h-10 rounded-none"
            disabled={!form.formState.isDirty}
          >
            Save
          </Button>
        </div>
      </form>
    </Form>
  );
}
