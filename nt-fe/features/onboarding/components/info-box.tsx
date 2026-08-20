"use client";

import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    File01Icon,
    PlayIcon,
    ViewIcon,
} from "@hugeicons/core-free-icons";
import {
    APP_DEMO_URL,
    APP_DOCS_URL,
    APP_ACTIVE_TREASURY,
} from "@/constants/config";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useMemo, useState, useEffect } from "react";
import { useNextStep } from "nextstepjs";
import { PageCard } from "@/components/card";
import { useSidebarStore } from "@/stores/sidebar-store";
import {
    LOCAL_STORAGE_KEYS,
    scheduleHelpSupportTour,
} from "../steps/dashboard";

const INFO_BOX_CLOSED_KEY = LOCAL_STORAGE_KEYS.INFO_BOX_TOUR_DISMISSED;

interface InfoItemProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    href: string;
}

function InfoItem({ icon, title, description, href }: InfoItemProps) {
    return (
        <Link
            href={href}
            target="_blank"
            className="block rounded-2xl outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
            <PageCard className="w-full gap-1.5 p-3 transition-colors hover:border-gray-300 hover:bg-gray-50 dark:hover:border-gray-700 dark:hover:bg-white/5">
                <div className="flex items-center gap-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700 dark:bg-white/10 dark:text-gray-300">
                        {icon}
                    </span>
                    <div className="flex flex-col">
                        <h3 className="font-semibold">{title}</h3>
                        <p className="text-sm text-muted-foreground">
                            {description}
                        </p>
                    </div>
                </div>
            </PageCard>
        </Link>
    );
}

export function InfoBox() {
    const t = useTranslations("onboarding.infoBox");
    const [isClosed, setIsClosed] = useState(true);
    const { startNextStep } = useNextStep();
    const setSidebarOpen = useSidebarStore((state) => state.setSidebarOpen);
    const infoItems = useMemo<InfoItemProps[]>(
        () => [
            {
                icon: <Icon icon={PlayIcon} />,
                title: t("videoTitle"),
                description: t("videoDescription"),
                href: APP_DEMO_URL,
            },
            {
                icon: <Icon icon={ViewIcon} />,
                title: t("demoTitle"),
                description: t("demoDescription"),
                href: APP_ACTIVE_TREASURY,
            },
            {
                icon: <Icon icon={File01Icon} />,
                title: t("docsTitle"),
                description: t("docsDescription"),
                href: APP_DOCS_URL,
            },
        ],
        [t],
    );

    useEffect(() => {
        setIsClosed(localStorage.getItem(INFO_BOX_CLOSED_KEY) === "true");
    }, []);

    const handleInfoBoxClick = () => {
        localStorage.setItem(INFO_BOX_CLOSED_KEY, "true");
        setIsClosed(true);
        scheduleHelpSupportTour(startNextStep, setSidebarOpen);
    };

    if (isClosed) {
        return null;
    }

    return (
        <div className="flex h-fit w-full cursor-pointer flex-col gap-5">
            <div className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                    <h2 className="font-bold text-2xl tracking-tight">
                        {t("title")}
                    </h2>
                    <button
                        type="button"
                        onClick={handleInfoBoxClick}
                        className="text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
                        aria-label={t("close")}
                    >
                        <Icon icon={Cancel01Icon} />
                    </button>
                </div>
            </div>
            <div className="flex flex-col gap-3">
                {infoItems.map((item, index) => (
                    <InfoItem key={index} {...item} />
                ))}
            </div>
        </div>
    );
}
