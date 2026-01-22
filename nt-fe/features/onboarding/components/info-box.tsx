
"use client";

import { APP_DEMO_URL, APP_DOCS_URL, APP_LEARN_URL, NEAR_TREASURY_CONFIG } from "@/constants/config";
import Link from "next/link";
import { CirclePlay, Eye, File, X } from "lucide-react";
import { useState, useEffect } from "react";
import { PageCard } from "@/components/card";
import { useNextStep } from "nextstepjs";
import { LOCAL_STORAGE_KEYS, TOUR_NAMES } from "../steps/dashboard";
import { useSidebarStore } from "@/stores/sidebar-store";
import { SIDEBAR_ANIMATION_DELAY } from "./tour-card";

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
                    <p className="text-sm text-muted-foreground">{description}</p>
                </div>
            </PageCard>
        </Link>
    );
}

const infoItems: InfoItemProps[] = [
    {
        icon: <Eye className="size-4" />,
        title: "See Active Treasuries",
        description: "Explore and see other accounts in action.",
        href: APP_LEARN_URL,
    },
    {
        icon: <File className="size-4" />,
        title: "App Docs",
        description: "Learn all features in the docs.",
        href: APP_DOCS_URL,
    },
    {
        icon: <CirclePlay className="size-4" />,
        title: "View Demo",
        description: "Watch the demo to explore how the Treasury works.",
        href: APP_DEMO_URL,
    },
];

export function InfoBox() {
    const [isClosed, setIsClosed] = useState(true);
    const { startNextStep } = useNextStep();
    const setSidebarOpen = useSidebarStore((state) => state.setSidebarOpen);

    useEffect(() => {
        setIsClosed(localStorage.getItem(INFO_BOX_CLOSED_KEY) === "true");
    }, []);

    const handleInfoBoxClick = () => {
        localStorage.setItem(INFO_BOX_CLOSED_KEY, "true");
        setIsClosed(true);
        // Open sidebar before starting tour since first step needs it
        setSidebarOpen(true);
        setTimeout(() => {
            startNextStep(TOUR_NAMES.INFO_BOX_DISMISSED);
        }, SIDEBAR_ANIMATION_DELAY);
    };

    if (isClosed) {
        return null;
    }

    return (
        <div
            className="bg-general-tertiary rounded-lg p-5 flex flex-col w-full h-fit gap-5 cursor-pointer hover:bg-general-tertiary/80 transition-colors"
        >
            <div className="flex flex-col gap-0.5">
                <div className="flex items-center justify-between">
                    <h1 className="font-semibold">Get more from {NEAR_TREASURY_CONFIG.brandName}</h1>
                    <button
                        onClick={handleInfoBoxClick}
                        className="text-muted-foreground hover:text-foreground transition-colors"
                        aria-label="Close"
                    >
                        <X className="size-4" />
                    </button>
                </div>
                <p className="text-sm text-muted-foreground">
                    Discover how others use Treasury, try the demo, and check the docs to learn the features.
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
