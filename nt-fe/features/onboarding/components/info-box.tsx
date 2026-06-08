"use client";

import {
    APP_DEMO_URL,
    APP_DOCS_URL,
    APP_ACTIVE_TREASURY,
} from "@/constants/config";
import Link from "next/link";
import { CirclePlay, Eye, File, X } from "lucide-react";
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
        <Link href={href} target="_blank">
            <PageCard className="w-full hover:bg-muted-foreground/10 border border-border gap-1.5 p-3">
                {icon}
                <div className="flex flex-col">
                    <h1 className="font-semibold">{title}</h1>
                    <p className="text-sm text-muted-foreground">
                        {description}
                    </p>
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
                icon: <Eye className="size-4" />,
                title: t("demoTitle"),
                description: t("demoDescription"),
                href: APP_ACTIVE_TREASURY,
            },
            {
                icon: <File className="size-4" />,
                title: t("docsTitle"),
                description: t("docsDescription"),
                href: APP_DOCS_URL,
            },
            {
                icon: <CirclePlay className="size-4" />,
                title: t("videoTitle"),
                description: t("videoDescription"),
                href: APP_DEMO_URL,
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
        <div className="bg-general-tertiary rounded-lg p-5 flex flex-col w-full h-fit gap-5 cursor-pointer">
            <div className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                    <h1 className="font-semibold">{t("title")}</h1>
                    <button
                        type="button"
                        onClick={handleInfoBoxClick}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        aria-label={t("close")}
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <p className="text-sm text-muted-foreground">
                    {t("description")}
                </p>
            </div>
            <div className="flex flex-col gap-3">
                {infoItems.map((item, index) => (
                    <InfoItem key={index} {...item} />
                ))}
            </div>
        </div>
    );
}
