"use client";

import { Sun, Moon, ArrowLeft } from "lucide-react";
import { useThemeStore } from "@/stores/theme-store";
import { Button } from "@/components/button";
import { ReactNode, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Logo from "./logo";

interface LegalPageLayoutProps {
    title: string;
    children: ReactNode;
}

export function LegalPageLayout({ title, children }: LegalPageLayoutProps) {
    const { theme, toggleTheme } = useThemeStore();
    const router = useRouter();

    useEffect(() => {
        if (typeof window !== "undefined") {
            document.documentElement.classList.toggle("dark", theme === "dark");
        }
    }, [theme]);

    return (
        <div className="flex flex-col min-h-screen">
            <header className="flex items-center min-h-14 justify-between bg-card px-4 md:px-6 border-b border-border">
                <div className="flex items-center gap-3">
                    <Link
                        href="/app"
                        className="text-lg font-bold hover:opacity-80"
                    >
                        <Logo />
                    </Link>
                    <span className="text-muted-foreground">|</span>
                    <span className="text-sm text-muted-foreground">
                        {title}
                    </span>
                </div>

                <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleTheme}
                    className="h-9 w-9 hover:bg-muted text-muted-foreground hover:text-foreground"
                >
                    {theme === "dark" ? (
                        <Sun className="h-5 w-5" />
                    ) : (
                        <Moon className="h-5 w-5" />
                    )}
                </Button>
            </header>

            <main className="flex-1 overflow-y-auto bg-page-bg p-4">
                {children}
            </main>

            <footer className="border-t border-border py-4 bg-card">
                <div className="container mx-auto px-4 text-center text-sm text-muted-foreground">
                    <div className="flex justify-center gap-6">
                        <Link href="/terms" className="hover:text-foreground">
                            Terms of Service
                        </Link>
                        <Link href="/privacy" className="hover:text-foreground">
                            Privacy Policy
                        </Link>
                    </div>
                </div>
            </footer>
        </div>
    );
}
