import { ChainIcons } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useThemeStore } from "@/stores/theme-store";

interface TokenDisplayProps {
    symbol: string;
    icon: string;
    chainIcons?: ChainIcons;
    iconSize?: "sm" | "md" | "lg";
}

const iconSizeClasses = {
    sm: "size-4",
    md: "size-5",
    lg: "size-6",
}


export const TokenDisplay = ({ symbol, icon, chainIcons, iconSize = "md" }: TokenDisplayProps) => {
    const { theme } = useThemeStore();

    const getNetworkIcon = () => {
        if (!chainIcons) return null;
        return theme === 'light' ? chainIcons.light : chainIcons.dark;
    };

    const networkIcon = getNetworkIcon();
    const isImageIcon = icon.startsWith("data:image") || icon.startsWith("http");

    return (
        <div className="relative flex">
            {isImageIcon ? (
                <img src={icon} alt={symbol} className={cn("rounded-full shrink-0", iconSizeClasses[iconSize])} />
            ) : (
                <div className={cn("rounded-full bg-blue-600 flex items-center justify-center text-xs shrink-0", iconSizeClasses[iconSize])}>
                    {icon}
                </div>
            )}
            {networkIcon && (
                <div className="absolute -right-1 -bottom-1 flex items-center justify-center rounded-full bg-muted border-border">
                    <img
                        src={networkIcon}
                        alt="network"
                        className="size-3 shrink-0 p-0.5"
                    />
                </div>
            )}
        </div>
    );
};
