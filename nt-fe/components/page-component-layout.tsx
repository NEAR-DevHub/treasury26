"use client";

import { ArrowLeft, Moon, PanelLeft, Sun } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect } from "react";
import { Button } from "@/components/button";
import { LanguageSwitcher } from "@/components/language-switcher";
import { Pill } from "@/components/pill";
import { SignIn } from "@/components/sign-in";
import { SystemStatusBanner } from "@/components/system-status-banner";
import { isStaging } from "@/constants/features";
import { ConfidentialBanner } from "@/features/confidential/components/confidential-banner";
import { useSidebarStore } from "@/stores/sidebar-store";
import { useThemeStore } from "@/stores/theme-store";

interface PageComponentLayoutProps {
    title: string;
    description?: string;
    backButton?: boolean | string;
    hideLogin?: boolean;
    hideCollapseButton?: boolean;
    logo?: ReactNode;
    children: ReactNode;
}

export function PageComponentLayout({
    title,
    description,
    backButton,
    hideCollapseButton,
    hideLogin,
    logo,
    children,
}: PageComponentLayoutProps) {
    const { toggleSidebar } = useSidebarStore();
    const { theme, toggleTheme } = useThemeStore();
    const tHeader = useTranslations("header");

    useEffect(() => {
        if (typeof window !== "undefined") {
            document.documentElement.classList.toggle("dark", theme === "dark");
        }
    }, [theme]);

    const router = useRouter();

    return (
        <div className="flex flex-col h-full">
            <header className="flex items-center min-h-14 justify-between bg-card px-2 md:px-6 border-b border-border">
                <div className="flex items-center gap-2 md:gap-4">
                    {!hideCollapseButton && (
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={toggleSidebar}
                            className="h-9 w-9 hover:bg-muted text-muted-foreground hover:text-foreground"
                            aria-label={tHeader("toggleSidebar")}
                        >
                            <PanelLeft className="h-6 w-6" />
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

                        {logo ?? (
                            <div className="flex items-baseline gap-2">
                                <h1 className="text-base md:text-lg font-bold">
                                    {title}
                                </h1>
                                {description && (
                                    <span className="hidden lg:inline text-xs text-muted-foreground">
                                        {description}
                                    </span>
                                )}
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex items-center gap-3">
                    {isStaging && (
                        <Pill
                            title="Staging"
                            icon={
                                <span className="size-1.5 rounded-full bg-general-orange-foreground" />
                            }
                            className="bg-general-orange-background-faded text-general-orange-foreground"
                        />
                    )}
                    <LanguageSwitcher />
                    <Button
                        variant="ghost"
                        size="icon"
                        onClick={toggleTheme}
                        aria-label={tHeader("toggleTheme")}
                        className="h-9 w-9 hover:bg-muted text-muted-foreground hover:text-foreground"
                    >
                        {theme === "dark" ? (
                            <Sun className="h-5 w-5" />
                        ) : (
                            <Moon className="h-5 w-5" />
                        )}
                    </Button>

                    {!hideLogin && <SignIn />}
                </div>
            </header>

            <main className="flex-1 overflow-y-auto bg-page-bg p-4">
                <SystemStatusBanner className="lg:hidden mb-3" />
                {children}
            </main>
        </div>
    );
}
