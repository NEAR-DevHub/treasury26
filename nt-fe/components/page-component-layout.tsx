"use client";

import { Menu, Sun, Moon, Bell, ArrowLeft } from "lucide-react";
import { useSidebar } from "@/stores/sidebar-store";
import { useThemeStore } from "@/stores/theme-store";
import { Button } from "@/components/button";
import { SignIn } from "@/components/sign-in";
import { ReactNode, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

interface PageComponentLayoutProps {
  title: string;
  description?: string;
  backButton?: boolean | string;
  children: ReactNode;
}

export function PageComponentLayout({ title, description, backButton, children }: PageComponentLayoutProps) {
  const { toggleSidebar } = useSidebar();
  const { theme, toggleTheme } = useThemeStore();

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
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            className="h-9 w-9 hover:bg-muted text-muted-foreground hover:text-foreground lg:hidden"
            aria-label="Toggle menu"
          >
            <Menu className="h-6 w-6" />
          </Button>
          <div className="flex items-center gap-2 md:gap-3">
            {backButton && (
              <Button
                variant="ghost"
                size="icon"
                className="hidden lg:flex"
                onClick={() => {
                  if (typeof backButton === 'string') {
                    // If there's history, go back; otherwise, navigate to the provided fallback URL
                    if (window.history.length > 1) {
                      router.back();
                    } else {
                      router.push(backButton);
                    }
                  } else {
                    router.back();
                  }
                }}
              >
                <ArrowLeft className="size-5 stroke-3" />
              </Button>
            )}
            <div className="flex items-baseline gap-2">
              <h1 className="text-base md:text-lg font-bold">{title}</h1>
              {description && (
                <span className="hidden md:inline text-xs text-muted-foreground">{description}</span>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
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

          <SignIn />
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-page-bg p-4">
        {children}
      </main>
    </div>
  );
}
