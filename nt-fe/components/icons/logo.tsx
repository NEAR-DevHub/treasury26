import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";
import Image from "next/image";

interface LogoProps {
    size?: "sm" | "md" | "lg";
    variant?: "full" | "icon";
    mode?: "auto" | "light" | "dark";
}

const sizeClasses = cva("w-auto", {
    variants: {
        size: {
            sm: "h-6",
            md: "h-8",
            lg: "h-10",
        },
    },
    defaultVariants: {
        size: "md",
    },
});

interface LogoInlinedProps {
    className?: string;
}

export function LogoInlined({ className }: LogoInlinedProps) {
    return (
        <svg
            className={className}
            viewBox="0 0 32 32"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
        >
            <path
                d="M14.8682 3H27.8682L14.8682 17H2.86816L14.8682 3Z"
                className="fill-foreground"
            />
            <path
                d="M14.8682 17H27.8682L14.8682 30V17Z"
                className="fill-foreground"
            />
        </svg>
    );
}

export default function Logo({
    size = "md",
    variant = "full",
    mode = "auto",
}: LogoProps) {
    const className = sizeClasses({ size });

    const darkSrc = variant === "icon" ? "/favicon_dark.svg" : "/logo_dark.svg";
    const lightSrc = variant === "icon" ? "/favicon_light.svg" : "/logo.svg";

    if (mode === "light") {
        return (
            <Image
                src={lightSrc}
                alt="Trezu"
                height={0}
                width={0}
                className={className}
            />
        );
    }

    if (mode === "dark") {
        return (
            <Image
                src={darkSrc}
                alt="Trezu"
                height={0}
                width={0}
                className={className}
            />
        );
    }

    return (
        <>
            <Image
                src={darkSrc}
                alt="Trezu"
                height={0}
                width={0}
                className={cn(className, "dark:block hidden")}
            />
            <Image
                src={lightSrc}
                alt="Trezu"
                height={0}
                width={0}
                className={cn(className, "dark:hidden")}
            />
        </>
    );
}
