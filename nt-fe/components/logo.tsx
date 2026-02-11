import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";
import Image from "next/image";

interface LogoProps {
    size?: "sm" | "md" | "lg";
    variant?: "full" | "icon";
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

export default function Logo({ size = "md", variant = "full" }: LogoProps) {
    const className = sizeClasses({ size });

    const darkSrc = variant === "icon" ? "/favicon_dark.svg" : "/logo_dark.svg";
    const lightSrc = variant === "icon" ? "/favicon_light.svg" : "/logo.svg";

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
