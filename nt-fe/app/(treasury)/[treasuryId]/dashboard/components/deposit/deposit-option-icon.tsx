"use client";

import { TokenIconImage } from "@/components/token-icon-image";
import { cn } from "@/lib/utils";

export function DepositOptionIcon({
    icon,
    name,
    gradient,
    className,
}: {
    icon: string;
    name: string;
    gradient?: string;
    className?: string;
}) {
    return (
        <TokenIconImage
            icon={icon}
            alt={name}
            gradient={gradient}
            className={cn("size-6", className)}
            objectFit="contain"
        />
    );
}
