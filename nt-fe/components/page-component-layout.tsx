"use client";

import { Menu, Sun, Moon, Bell, ChevronDown } from "lucide-react";
import { useSidebar } from "@/stores/sidebar-store";
import { useThemeStore } from "@/stores/theme-store";
import { Button } from "@/components/ui/button";
import { ReactNode, useEffect } from "react";

interface PageComponentLayoutProps {
  title: string;
  description?: string;
  children: ReactNode;
}

export function PageComponentLayout({ title, description, children }: PageComponentLayoutProps) {
  const { toggleSidebar } = useSidebar();
  const { theme, toggleTheme } = useThemeStore();

  useEffect(() => {
    if (typeof window !== "undefined") {
      document.documentElement.classList.toggle("dark", theme === "dark");
    }
  }, [theme]);

  return (
    <div className="flex flex-col h-full">
      <header className="flex items-center justify-between bg-header-bg p-2 px-6 border-b border-border">
        <div className="flex items-center gap-4">
          <Button
            variant="ghost"
            size="icon"
            onClick={toggleSidebar}
            className="h-9 w-9 hover:bg-muted text-muted-foreground hover:text-foreground lg:hidden"
            aria-label="Toggle menu"
          >
            <Menu className="h-6 w-6" />
          </Button>
          <div className="flex items-baseline gap-3">
            <h1 className="text-lg font-bold">{title}</h1>
            {description && (
              <span className="hidden md:inline text-xs text-muted-foreground">{description}</span>
            )}
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

          <Button variant="ghost" size="icon" className="relative h-9 w-9 hover:bg-muted text-muted-foreground hover:text-foreground">
            <Bell className="h-5 w-5" />
          </Button>

          <div className="flex items-center gap-2 rounded-lg px-3 py-1.5 hover:bg-muted cursor-pointer">
            <div className="h-8 w-8 rounded-full bg-blue-600 flex items-center justify-center">
              <span className="text-xs font-semibold text-white">HN</span>
            </div>
            <span className="text-sm font-medium hidden sm:inline">harry.near</span>
            <ChevronDown className="h-4 w-4 text-muted-foreground hidden sm:inline" />
          </div>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto bg-page-bg p-8">
        {children}
      </main>
    </div>
  );
}
