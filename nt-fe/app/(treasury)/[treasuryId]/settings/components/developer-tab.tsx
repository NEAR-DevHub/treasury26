"use client";

import { CodeXml } from "lucide-react";
/**
 * Settings → Developer tab. Hosts the opt-in for Custom Requests (the custom-proposal-templates
 * feature). Enabling it (ChangePolicy-gated server-side) reveals the Request Templates section in
 * the sidebar; the first time a treasury turns it on, we run the one-step onboarding tour pointing
 * at that freshly revealed item.
 */
import { useTranslations } from "next-intl";
import { useNextStep } from "nextstepjs";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import {
    PAGE_TOUR_STORAGE_KEYS,
    REQUEST_TEMPLATES_TOUR_NAME,
} from "@/features/onboarding/steps/page-tours";
import { apiErrorMessage } from "@/features/proposal-templates/api";
import {
    useCustomRequestsEnabled,
    useSetCustomRequestsEnabled,
} from "@/features/proposal-templates/hooks/use-custom-requests-enabled";
import { useTreasury } from "@/hooks/use-treasury";

export function DeveloperTab() {
    const t = useTranslations("customTemplates");
    const { treasuryId } = useTreasury();
    const { data: enabled, isLoading } = useCustomRequestsEnabled();
    const setEnabled = useSetCustomRequestsEnabled();
    const { startNextStep, currentTour } = useNextStep();
    // Set when *this user* clicks Enable, so the tour only follows a deliberate action (not merely
    // opening Settings on an already-enabled treasury).
    const [tourRequested, setTourRequested] = useState(false);

    // Show once per treasury, ever. Keyed so each DAO a user enables gets its own hint.
    const tourShownKey = `${PAGE_TOUR_STORAGE_KEYS.REQUEST_TEMPLATES_SHOWN}:${treasuryId}`;
    const fired = useRef(false);

    // Fire the tour off the flag actually flipping true — i.e. once the sidebar has re-rendered the
    // #request-templates-nav anchor — rather than a wall-clock guess, so it can't race the render.
    useEffect(() => {
        if (!tourRequested || !enabled || fired.current) {
            return;
        }
        if (currentTour) {
            return;
        }
        if (
            typeof window !== "undefined" &&
            localStorage.getItem(tourShownKey) === "true"
        ) {
            setTourRequested(false);
            return;
        }
        fired.current = true;
        setTourRequested(false);
        localStorage.setItem(tourShownKey, "true");
        startNextStep(REQUEST_TEMPLATES_TOUR_NAME);
    }, [tourRequested, enabled, currentTour, startNextStep, tourShownKey]);

    function toggle(next: boolean) {
        setEnabled.mutate(next, {
            onSuccess: () => {
                if (next) {
                    setTourRequested(true);
                }
            },
            onError: (error) =>
                toast.error(apiErrorMessage(error, t("developer.errUpdate"))),
        });
    }

    return (
        <PageCard>
            <div className="flex items-start gap-4">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                    <CodeXml className="size-5" />
                </div>
                <div className="flex flex-1 flex-col gap-1">
                    <h3 className="font-semibold text-base">
                        {t("developer.title")}
                    </h3>
                    <p className="text-muted-foreground text-sm">
                        {t("developer.description")}
                    </p>
                </div>
                <Button
                    variant={enabled ? "outline" : "default"}
                    disabled={isLoading || setEnabled.isPending}
                    onClick={() => toggle(!enabled)}
                >
                    {enabled ? t("developer.disable") : t("developer.enable")}
                </Button>
            </div>
        </PageCard>
    );
}
