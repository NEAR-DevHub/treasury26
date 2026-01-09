"use client";

import { Toaster as SonnerToaster } from "sonner";
import { useThemeStore } from "@/stores/theme-store";
import { CircleAlert, CircleCheck, } from "lucide-react";

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
          title: "text-foreground font-medium text-sm",
          description: " text-muted-foreground",
          success: "bg-white dark:bg-white",
          error: "bg-white dark:bg-white",
        },
      }}
      icons={{
        success: <CircleCheck className="size-4 fill-general-success-foreground text-white shrink-0" />,
        error: <CircleAlert className="size-4 fill-destructive text-white shrink-0" />,
      }}
    />
  );
}
