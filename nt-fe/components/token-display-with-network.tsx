"use client";

import type { ChainIcons } from "@/lib/api";
import { TokenIconImage, type TokenIconSize } from "./token-icon-image";

export type { TokenIconSize };

interface TokenDisplayProps {
    symbol: string;
    icon: string;
    chainIcons?: ChainIcons;
    iconSize?: TokenIconSize;
    /** Overrides the icon geometry when a call site needs an off-scale size. */
    className?: string;
}

export const TokenDisplay = ({
    symbol,
    icon,
    chainIcons,
    iconSize = "md",
    className,
}: TokenDisplayProps) => {
    return (
        <div className="relative flex">
            <TokenIconImage
                icon={icon}
                alt={symbol}
                size={iconSize}
                className={className}
            />
            <TokenIconImage
                icon={chainIcons?.icon}
                alt="network"
                size={iconSize}
                badge
            />
        </div>
    );
};
