"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useThemeStore } from "@/stores/theme-store";
import { CheckCircle2, XCircle } from "lucide-react";

export function Toaster() {
  const { theme } = useThemeStore();

  return (
    <SonnerToaster
      theme={theme === "dark" ? "dark" : "light"}
      position="bottom-center"
      richColors={false}
      toastOptions={{
        unstyled: false,
        classNames: {
          toast: "bg-white dark:bg-white border border-border shadow-lg",
          title: "text-foreground",
          description: "text-muted-foreground",
          success: "bg-white dark:bg-white",
          error: "bg-white dark:bg-white",
        },
      }}
      icons={{
        success: <CheckCircle2 className="w-5 h-5 text-green-600" />,
        error: <XCircle className="w-5 h-5 text-red-600" />,
      }}
    />
  );
}
