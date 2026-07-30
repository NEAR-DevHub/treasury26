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
            <PageCard
                radius="2xl"
                className="w-full gap-1.5 p-3 transition-colors hover:border-gray-300 hover:bg-gray-50"
            >
                <div className="flex items-center gap-4">
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-gray-100 text-gray-700">
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
                icon: <CirclePlay className="size-4.5" />,
                title: t("videoTitle"),
                description: t("videoDescription"),
                href: APP_DEMO_URL,
            },
            {
                icon: <Eye className="size-4.5" />,
                title: t("demoTitle"),
                description: t("demoDescription"),
                href: APP_ACTIVE_TREASURY,
            },
            {
                icon: <File className="size-4.5" />,
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
                        <X className="size-4" />
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
