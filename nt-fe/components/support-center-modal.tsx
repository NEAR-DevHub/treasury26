"use client";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import {
    APP_DEMO_URL,
    APP_DOCS_URL,
    APP_LEARN_URL,
    APP_TWITTER_URL,
    APP_SUPPORT_URL,
} from "@/constants/config";
import Link from "next/link";
import { CirclePlay, Eye, File, Headphones } from "lucide-react";

function XIcon({ className }: { className?: string }) {
    return (
        <svg className={className} viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
    );
}

interface SupportItemProps {
    icon: React.ReactNode;
    title: string;
    description: string;
    href: string;
}

function SupportItem({ icon, title, description, href }: SupportItemProps) {
    return (
        <Link
            href={href}
            target="_blank"
            className="flex bg-secondary items-center gap-2 p-2 rounded-6 hover:bg-general-tertiary transition-colors"
        >
            <div className="shrink-0 text-foreground">{icon}</div>
            <div className="flex flex-col min-w-0">
                <span className="text-sm text-foreground">{title}</span>
                <span className="text-sm text-muted-foreground">
                    {description}
                </span>
            </div>
        </Link>
    );
}

const resourceItems: SupportItemProps[] = [
    {
        icon: <Eye className="size-5" />,
        title: "See Active Treasuries",
        description: "Explore and see other accounts in action",
        href: APP_LEARN_URL,
    },
    {
        icon: <CirclePlay className="size-5" />,
        title: "View Demo",
        description: "Watch the demo to explore how the Treasury works",
        href: APP_DEMO_URL,
    },
    {
        icon: <XIcon className="size-5" />,
        title: "Follow Us on X",
        description: "Follow Us on X for updates, releases and insights",
        href: APP_TWITTER_URL,
    },
];

const supportItems: SupportItemProps[] = [
    {
        icon: <File className="size-5" />,
        title: "App Docs",
        description: "Learn all features in the docs",
        href: APP_DOCS_URL,
    },
    {
        icon: <Headphones className="size-5" />,
        title: "Product Support",
        description: "Get help from our support team",
        href: APP_SUPPORT_URL,
    },
];

interface SupportCenterModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function SupportCenterModal({
    open,
    onOpenChange,
}: SupportCenterModalProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-[448px]">
                <DialogHeader>
                    <DialogTitle className="text-left">
                        Support Center
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-semibold text-muted-foreground">
                            Resources
                        </span>
                        <div className="flex flex-col gap-3">
                            {resourceItems.map((item) => (
                                <SupportItem key={item.title} {...item} />
                            ))}
                        </div>
                    </div>

                    <div className="flex flex-col gap-2">
                        <span className="text-sm font-semibold text-muted-foreground">
                            Support
                        </span>
                        <div className="flex flex-col gap-3">
                            {supportItems.map((item) => (
                                <SupportItem key={item.title} {...item} />
                            ))}
                        </div>
                    </div>
                </div>
            </DialogContent>
        </Dialog>
    );
}
