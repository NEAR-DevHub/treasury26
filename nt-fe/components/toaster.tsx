"use client";

import { Toaster as SonnerToaster, toast } from "sonner";
import { useTheme } from "next-themes";
import { Check } from "lucide-react";

const ErrorIcon = () => (
    <svg
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
    >
        <path
            d="M8.00065 14.6673C11.6825 14.6673 14.6673 11.6825 14.6673 8.00065C14.6673 4.31875 11.6825 1.33398 8.00065 1.33398C4.31875 1.33398 1.33398 4.31875 1.33398 8.00065C1.33398 11.6825 4.31875 14.6673 8.00065 14.6673Z"
            fill="#DC2626"
        />
        <path
            d="M8 5.33398V8.00065"
            stroke="#F5F5F5"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
        <path
            d="M8 10.666H8.00667"
            stroke="#F5F5F5"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
        />
    </svg>
);

export function Toaster() {
    const { resolvedTheme } = useTheme();
    const theme = resolvedTheme === "dark" ? "dark" : "light";

    return (
        <SonnerToaster
            theme={theme}
            position="bottom-center"
            richColors={false}
            toastOptions={{
                unstyled: false,
                classNames: {
                    toast: "bg-card text-card-foreground border border-border shadow-lg",
                    title: "text-card-foreground font-medium text-sm",
                    description: "text-muted-foreground",
                    success: "bg-card text-card-foreground",
                    error: "bg-card text-card-foreground",
                },
            }}
            icons={{
                success: (
                    <Check className="size-3.5 p-0.5 bg-general-success-foreground rounded-full stroke-3 text-white shrink-0" />
                ),
                error: <ErrorIcon />,
            }}
        />
    );
}
