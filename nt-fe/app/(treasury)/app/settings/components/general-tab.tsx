"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Database } from "lucide-react";
import { useState } from "react";
import { Separator } from "@/components/ui/separator";
import { type Treasury } from "@/stores/treasury-store";

const COLOR_OPTIONS = [
  "#6B7280", // gray
  "#EF4444", // red
  "#F97316", // orange
  "#F59E0B", // amber
  "#EAB308", // yellow
  "#84CC16", // lime
  "#22C55E", // green
  "#14B8A6", // teal
  "#06B6D4", // cyan
  "#0EA5E9", // sky
  "#3B82F6", // blue
  "#6366F1", // indigo
  "#8B5CF6", // violet
  "#A855F7", // purple
  "#D946EF", // fuchsia
  "#EC4899", // pink
  "#F43F5E", // rose
];

interface GeneralTabProps {
  currentTreasury?: Treasury;
}

export function GeneralTab({ currentTreasury }: GeneralTabProps) {
  const [displayName, setDisplayName] = useState(currentTreasury?.name || "");
  const [accountName, setAccountName] = useState(currentTreasury?.value || "");
  const [selectedColor, setSelectedColor] = useState("#3B82F6");

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Treasury Name</h3>
          <p className="text-sm text-muted-foreground">
            The name of your treasury. This will be displayed across the app.
          </p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="display-name">Display Name</Label>
            <Input
              id="display-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="account-name">Account Name</Label>
            <Input
              id="account-name"
              value={accountName}
              onChange={(e) => setAccountName(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div className="flex flex-col rounded-lg border bg-card space-y-4">
        <div className="p-6 pb-0">
          <h3 className="text-lg font-semibold">Logo</h3>
          <p className="text-xs text-muted-foreground">
            Upload a logo for your treasury. Recommended size: 256x256px.
          </p>
        </div>

        <Separator />

        <div className="flex items-center gap-4 p-6 pt-0">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Database className="h-8 w-8 shrink-0 text-muted-foreground" />
          </div>
          <Button variant="outline">Upload Logo</Button>
        </div>
      </div>

      <div className="rounded-lg border bg-card p-6 space-y-4">
        <div>
          <h3 className="text-lg font-semibold">Primary Color</h3>
          <p className="text-sm text-muted-foreground">
            Set the primary color for your treasury's interface elements.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {COLOR_OPTIONS.map((color) => (
            <button
              key={color}
              onClick={() => setSelectedColor(color)}
              className={`h-10 w-10 rounded-full transition-all hover:scale-110 ${
                selectedColor === color
                  ? "ring-2 ring-offset-2 ring-offset-background ring-primary"
                  : ""
              }`}
              style={{ backgroundColor: color }}
              aria-label={`Select color ${color}`}
            />
          ))}
        </div>
      </div>

      <div className="rounded-lg border bg-card">
        <Button className="w-full h-14 text-base font-semibold rounded-lg">
          Create Request
        </Button>
      </div>
    </div>
  );
}
