"use client";

import { ArrowLeft, Moon, PanelLeft, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useState } from "react";
import { useHasSidebarRail } from "@/components/app-shell-context";
import { Button } from "@/components/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Pill } from "@/components/pill";
import { SignIn } from "@/components/sign-in";
import { SlotWarning } from "@/components/warning-message";
import { isStaging } from "@/constants/features";
import { ConfidentialBanner } from "@/features/confidential/components/confidential-banner";
import { cn } from "@/lib/utils";
import { useSidebarStore } from "@/stores/sidebar-store";

interface PageComponentLayoutProps {
    title: string;
    description?: string;
    backButton?: boolean | string;
    hideLogin?: boolean;
    hideCollapseButton?: boolean;
    hideAppWarningBanner?: boolean;
    transparentHeader?: boolean;
    hideHeaderBottomBorder?: boolean;
    /** Renders an empty header: no logo/title, staging pill, language or theme controls. */
    hideHeaderContent?: boolean;
    logo?: ReactNode;
    mainClassName?: string;
    children: ReactNode;
}

export function PageComponentLayout({
    title,
    description,
    backButton,
    hideCollapseButton,
    hideLogin,
    hideAppWarningBanner,
    transparentHeader = false,
    hideHeaderBottomBorder = false,
    hideHeaderContent = false,
    logo,
    mainClassName,
    children,
}: PageComponentLayoutProps) {
    const { toggleSidebar } = useSidebarStore();
    const { resolvedTheme, setTheme } = useTheme();
    const [mounted, setMounted] = useState(false);
    const tHeader = useTranslations("header");
    // Inside the treasury shell these controls live in the sidebar profile menu.
    const hasSidebarRail = useHasSidebarRail();

    useEffect(() => {
        setMounted(true);
    }, []);

    const isDarkTheme = mounted ? resolvedTheme === "dark" : true;

    const router = useRouter();

    return (
        <div className="flex flex-col h-full">
            <header
                className={cn(
                    "flex items-center min-h-16 justify-between px-2 md:px-6",
                    // Inside the shell the header is part of the floating panel:
                    // transparent and borderless.
                    !hasSidebarRail &&
                        !hideHeaderBottomBorder &&
                        "border-b border-border",
                    hasSidebarRail || transparentHeader
                        ? "bg-transparent"
                        : "bg-card",
                )}
            >
                <div className="flex items-center gap-2 md:gap-4">
                    {!hideCollapseButton && (
                        <Button
                            variant="ghost"
                            size="icon-sm"
                            onClick={toggleSidebar}
                            className="text-muted-foreground hover:bg-muted hover:text-foreground"
                            aria-label={tHeader("toggleSidebar")}
                        >
                            <PanelLeft className="size-5" />
                        </Button>
                    )}
                    <div className="flex items-center gap-2 md:gap-3">
                        {backButton && (
                            <Button
                                variant="ghost"
                                size="icon"
                                onClick={() => {
                                    if (typeof backButton === "string") {
                                        router.push(backButton);
                                    } else {
                                        router.back();
                                    }
                                }}
                            >
                                <ArrowLeft className="size-5 stroke-2" />
                            </Button>
                        )}

                        <ConfidentialBanner type="mini" className="lg:hidden" />

                        {!hideHeaderContent &&
                            (logo ?? (
                                <div className="flex items-baseline gap-2">
                                    <h1 className="text-xl font-semibold tracking-tight">
                                        {title}
                                    </h1>
                                    {description && (
                                        <span className="hidden lg:inline text-xs text-muted-foreground">
                                            {description}
                                        </span>
                                    )}
                                </div>
                            ))}
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {!hasSidebarRail && !hideHeaderContent && isStaging && (
                        <>
                            <span
                                className="size-2 rounded-full bg-general-orange-foreground md:hidden"
                                title="Staging"
                                aria-label="Staging"
                            />
                            <Pill
                                title="Staging"
                                icon={
                                    <span className="size-1.5 rounded-full bg-general-orange-foreground" />
                                }
                                className="hidden md:flex bg-general-orange-background-faded text-general-orange-foreground"
                            />
                        </>
                    )}
                    {!hasSidebarRail && !hideHeaderContent && (
                        <>
                            <LanguageSwitcher />
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                onClick={() =>
                                    setTheme(isDarkTheme ? "light" : "dark")
                                }
                                aria-label={tHeader("toggleTheme")}
                                className="text-muted-foreground hover:bg-muted hover:text-foreground"
                            >
                                {isDarkTheme ? (
                                    <Sun className="size-5" />
                                ) : (
                                    <Moon className="size-5" />
                                )}
                            </Button>

                            {!hideLogin && <SignIn />}
                        </>
                    )}
                </div>
            </header>

            <main
                className={cn(
                    "flex-1 overflow-y-auto px-4 pb-6 md:px-6 md:pb-8",
                    // Inside the shell the floating panel owns the surface, so
                    // the content area must not paint over it.
                    hasSidebarRail ? "bg-transparent" : "bg-page-bg",
                    mainClassName,
                )}
            >
                {!hideAppWarningBanner && (
                    <>
                        <SlotWarning
                            slot="data.balances"
                            className="lg:hidden mb-3"
                            headingClassName="font-medium"
                        />
                        <SlotWarning slot="app" className="lg:hidden mb-3" />
                    </>
                )}
                {children}
            </main>
        </div>
    );
}
