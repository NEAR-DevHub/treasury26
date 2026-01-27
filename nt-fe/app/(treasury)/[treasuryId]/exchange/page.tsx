"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { PageCard } from "@/components/card";
import { PendingButton } from "@/components/pending-button";
import { Button } from "@/components/button";
import { SlidersHorizontal } from "lucide-react";
import {
  usePageTour,
  PAGE_TOUR_NAMES,
  PAGE_TOUR_STORAGE_KEYS,
} from "@/features/onboarding/steps/page-tours";

export default function ExchangePage() {
  // Onboarding tour
  usePageTour(PAGE_TOUR_NAMES.EXCHANGE_SETTINGS, PAGE_TOUR_STORAGE_KEYS.EXCHANGE_SETTINGS_SHOWN);

  return (
    <PageComponentLayout title="Exchange" description="Exchange your tokens securely and efficiently">
      <PageCard className="max-w-[600px] mx-auto">
        <div className="flex items-center justify-between">
          <p className="font-semibold">Exchange</p>
          <div className="flex items-center gap-3">
            <PendingButton
              id="exchange-pending-btn"
              types={["Exchange"]}
            />
            <Button
              id="exchange-settings-btn"
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-8 border-2"
            >
              <SlidersHorizontal className="w-4 h-4" />
            </Button>
          </div>
        </div>
        <p className="text-muted-foreground">
          Exchange tokens and manage conversions.
        </p>
      </PageCard>
    </PageComponentLayout>
  );
}
