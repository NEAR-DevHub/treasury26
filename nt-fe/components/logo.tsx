import { cn } from "@/lib/utils";
import { cva } from "class-variance-authority";
import Image from "next/image";

interface LogoProps {
    size?: "sm" | "md" | "lg";
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

export default function Logo({ size = "md" }: LogoProps) {
    const className = sizeClasses({ size });
    return (
        <>
            <Image
                src="/logo_dark.svg"
                alt="Trezu"
                height={0}
                width={0}
                className={cn(className, "dark:block hidden")}
            />
            <Image
                src="/logo.svg"
                alt="Trezu"
                height={0}
                width={0}
                className={cn(className, "dark:hidden")}
            />
        </>
    );
}
