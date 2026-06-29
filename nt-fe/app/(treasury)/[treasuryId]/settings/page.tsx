"use client";

import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Suspense, useEffect, useState } from "react";
import { PageComponentLayout } from "@/components/page-component-layout";
import { TabGroup } from "@/components/tab-group";
import { features } from "@/constants/features";
import { useTreasury } from "@/hooks/use-treasury";
import { DeveloperTab } from "./components/developer-tab";
import { GeneralTab } from "./components/general-tab";
import { IntegrationsTab } from "./components/integrations-tab";
import { PreferencesTab } from "./components/preferences-tab";
import { VotingTab } from "./components/voting-tab";

function SettingsPageContent() {
    const t = useTranslations("pages.settings");
    const tTabs = useTranslations("settings.tabs");
    const searchParams = useSearchParams();
    const tabFromUrl = searchParams.get("tab");
    // The Developer tab only does anything for a signed-in member (its Enable action is
    // ChangePolicy-gated), so hide it from guests and signed-out viewers — same idea as the
    // feature-flag-gated Integrations tab.
    const { isGuestTreasury } = useTreasury();
    const showDeveloper = !isGuestTreasury;
    const [activeTab, setActiveTab] = useState(() => {
        if (tabFromUrl === "integrations" && features.integrations) {
            return "integrations";
        }
        if (tabFromUrl === "developer" && showDeveloper) {
            return "developer";
        }
        return "general";
    });

    useEffect(() => {
        const tab = searchParams.get("tab");
        if (tab === "integrations" && features.integrations) {
            setActiveTab("integrations");
        } else if (tab === "developer" && showDeveloper) {
            setActiveTab("developer");
        }
    }, [searchParams, showDeveloper]);

    // `isGuestTreasury` resolves async, so a guest can land on `?tab=developer` before it's known;
    // once Developer is hidden, never strand on it (no matching tab or body).
    useEffect(() => {
        if (!showDeveloper) {
            setActiveTab((current) =>
                current === "developer" ? "general" : current,
            );
        }
    }, [showDeveloper]);

    const tabs = [
        { value: "general", label: tTabs("general") },
        { value: "voting", label: tTabs("voting") },
        { value: "preferences", label: tTabs("preferences") },
        ...(features.integrations
            ? [
                  {
                      value: "integrations",
                      label: tTabs("integrations"),
                      showNewPill: true,
                  },
              ]
            : []),
        ...(showDeveloper
            ? [{ value: "developer", label: tTabs("developer") }]
            : []),
    ];

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <div className="w-full max-w-4xl mx-auto">
                <div className="flex mb-6">
                    <TabGroup
                        tabs={tabs}
                        activeTab={activeTab}
                        onTabChange={setActiveTab}
                    />
                </div>

                {activeTab === "general" && <GeneralTab />}
                {activeTab === "voting" && <VotingTab />}
                {activeTab === "preferences" && <PreferencesTab />}
                {activeTab === "integrations" && features.integrations && (
                    <IntegrationsTab />
                )}
                {activeTab === "developer" && showDeveloper && <DeveloperTab />}
            </div>
        </PageComponentLayout>
    );
}

export default function SettingsPage() {
    const t = useTranslations("pages.settings");

    return (
        <Suspense
            fallback={
                <PageComponentLayout
                    title={t("title")}
                    description={t("description")}
                >
                    <div className="w-full max-w-4xl mx-auto min-h-48" />
                </PageComponentLayout>
            }
        >
            <SettingsPageContent />
        </Suspense>
    );
}
