"use client";

import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useState } from "react";

const TIMEZONES = [
  { value: "GMT-12:00", label: "(GMT-12:00) International Date Line West" },
  { value: "GMT-11:00", label: "(GMT-11:00) Midway Island, Samoa" },
  { value: "GMT-10:00", label: "(GMT-10:00) Hawaii" },
  { value: "GMT-09:00", label: "(GMT-09:00) Alaska" },
  { value: "GMT-08:00", label: "(GMT-08:00) Pacific Time (US & Canada)" },
  { value: "GMT-07:00", label: "(GMT-07:00) Mountain Time (US & Canada)" },
  { value: "GMT-06:00", label: "(GMT-06:00) Central Time (US & Canada)" },
  { value: "GMT-05:00", label: "(GMT-05:00) Eastern Time (US & Canada)" },
  { value: "GMT-04:00", label: "(GMT-04:00) Atlantic Time (Canada)" },
  { value: "GMT-03:00", label: "(GMT-03:00) Buenos Aires, Georgetown" },
  { value: "GMT-02:00", label: "(GMT-02:00) Mid-Atlantic" },
  { value: "GMT-01:00", label: "(GMT-01:00) Azores, Cape Verde Islands" },
  { value: "GMT+00:00", label: "(GMT+00:00) London, Dublin, Lisbon" },
  { value: "GMT+01:00", label: "(GMT+01:00) Amsterdam, Berlin, Bern, Rome, Stockholm, Vienna" },
  { value: "GMT+02:00", label: "(GMT+02:00) Athens, Bucharest, Istanbul" },
  { value: "GMT+03:00", label: "(GMT+03:00) Moscow, St. Petersburg, Volgograd" },
  { value: "GMT+04:00", label: "(GMT+04:00) Abu Dhabi, Muscat, Baku, Tbilisi" },
  { value: "GMT+05:00", label: "(GMT+05:00) Islamabad, Karachi, Tashkent" },
  { value: "GMT+05:30", label: "(GMT+05:30) Chennai, Kolkata, Mumbai, New Delhi" },
  { value: "GMT+06:00", label: "(GMT+06:00) Almaty, Novosibirsk, Dhaka" },
  { value: "GMT+07:00", label: "(GMT+07:00) Bangkok, Hanoi, Jakarta" },
  { value: "GMT+08:00", label: "(GMT+08:00) Beijing, Hong Kong, Singapore" },
  { value: "GMT+09:00", label: "(GMT+09:00) Tokyo, Seoul, Osaka" },
  { value: "GMT+10:00", label: "(GMT+10:00) Sydney, Melbourne, Brisbane" },
  { value: "GMT+11:00", label: "(GMT+11:00) Solomon Islands, New Caledonia" },
  { value: "GMT+12:00", label: "(GMT+12:00) Auckland, Wellington, Fiji" },
];

export function PreferencesTab() {
  const [timezone, setTimezone] = useState("GMT+01:00");

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Time Zone</h3>
          <p className="text-sm text-muted-foreground">
            Set your local time zone for accurate date and time display.
          </p>
        </div>

        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz.value} value={tz.value}>
                {tz.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border bg-card">
        <Button className="w-full h-14 text-base font-semibold rounded-lg">
          Save
        </Button>
      </div>
    </div>
  );
}
