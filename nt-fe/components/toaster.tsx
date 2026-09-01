"use client";

import { Icon } from "@/components/icon";
import { CheckIcon } from "@hugeicons/core-free-icons";
import { Toaster as SonnerToaster } from "sonner";
import { useMediaQuery } from "@/hooks/use-media-query";

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
    const isMobile = useMediaQuery("(max-width: 1023px)");

    return (
        <SonnerToaster
            theme="dark"
            position={isMobile ? "top-center" : "top-right"}
            richColors={false}
            toastOptions={{
                unstyled: false,
                classNames: {
                    toast: "bg-zinc-900 text-white border-0 shadow-lg rounded-2xl",
                    title: "text-white font-medium text-sm",
                    description: "text-white/80",
                    success: "bg-zinc-900 text-white",
                    error: "bg-zinc-900 text-white",
                    actionButton:
                        "bg-transparent text-white hover:bg-transparent border-0 shadow-none",
                },
            }}
            icons={{
                success: (
                    <Icon
                        icon={CheckIcon}
                        className="p-0.5 bg-general-success-foreground rounded-full stroke-3 text-zinc-950 shrink-0"
                    />
                ),
                error: <ErrorIcon />,
            }}
        />
    );
}
