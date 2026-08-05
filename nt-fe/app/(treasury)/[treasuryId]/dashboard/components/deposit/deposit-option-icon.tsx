import { cn } from "@/lib/utils";

export function DepositOptionIcon({
    icon,
    name,
    gradient,
}: {
    icon: string;
    name: string;
    gradient?: string;
}) {
    const isUrl =
        icon?.startsWith("http") ||
        icon?.startsWith("data:") ||
        icon?.startsWith("/");

    if (isUrl) {
        return (
            <div className="w-6 h-6 rounded-full overflow-hidden shrink-0">
                <img
                    src={icon}
                    alt={name}
                    className="w-full h-full rounded-full object-contain"
                />
            </div>
        );
    }

    return (
        <div
            className={cn(
                "w-6 h-6 rounded-full flex items-center justify-center text-white text-xs font-normal shrink-0",
                gradient ?? "bg-brand-blue",
            )}
        >
            {icon}
        </div>
    );
}
