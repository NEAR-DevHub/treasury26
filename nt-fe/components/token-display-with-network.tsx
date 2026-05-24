import { ChainIcons } from "@/lib/api";
import { cn } from "@/lib/utils";

interface TokenDisplayProps {
    symbol: string;
    icon: string;
    chainIcons?: ChainIcons;
    iconSize?: "sm" | "md" | "lg" | "xl";
}

const iconSizeClasses = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
    xl: "size-9",
};

const networkIconSizeClasses = {
    sm: "size-2.5",
    md: "size-3",
    lg: "size-3",
    xl: "size-4",
};

export const TokenDisplay = ({
    symbol,
    icon,
    chainIcons,
    iconSize = "md",
}: TokenDisplayProps) => {
    const networkIcon = chainIcons?.icon ?? null;
    const isImageIcon =
        icon && (icon.startsWith("data:image") || icon.startsWith("http"));

    return (
        <div className="relative flex">
            {isImageIcon ? (
                <img
                    src={icon}
                    alt={symbol}
                    className={cn(
                        "rounded-full shrink-0",
                        iconSizeClasses[iconSize],
                    )}
                />
            ) : (
                <div
                    className={cn(
                        "rounded-full bg-gradient-cyan-blue flex items-center justify-center text-xs text-white font-semibold shrink-0",
                        iconSizeClasses[iconSize],
                    )}
                >
                    {icon || symbol.charAt(0).toUpperCase()}
                </div>
            )}
            {networkIcon && (
                <div className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-muted border border-border">
                    <img
                        src={networkIcon}
                        alt="network"
                        className={cn(
                            "shrink-0 p-0.5",
                            networkIconSizeClasses[iconSize],
                        )}
                    />
                </div>
            )}
        </div>
    );
};
