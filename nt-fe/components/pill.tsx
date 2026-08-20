import { Icon } from "@/components/icon";
import { InformationCircleIcon } from "@hugeicons/core-free-icons";
import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";

interface PillProps {
    id?: string;
    title: string;
    info?: string;
    icon?: React.ReactNode;
    variant?: "default" | "card" | "secondary" | "info" | "primary";
    side?: "top" | "bottom" | "left" | "right";
    className?: string;
}

const variants = {
    default: "",
    primary: "bg-popover-foreground text-popover",
    card: "bg-card text-card-foreground",
    secondary: "bg-secondary text-secondary-foreground",
    info: "bg-general-info-background-faded text-general-info-foreground",
};

export function Pill({
    id,
    title,
    info,
    icon,
    variant = "default",
    side,
    className,
}: PillProps) {
    const pill = (
        <div
            id={id}
            className={cn(
                "flex rounded-md items-center py-[3px] px-2 gap-1.5 w-fit text-xs font-medium text-center",
                variants[variant],
                className,
            )}
        >
            {info && <Icon icon={InformationCircleIcon} className="shrink-0" />}
            {!info && icon}
            {title}
        </div>
    );
    if (info) {
        // pointer-events-auto so hover still works when the Pill sits inside a
        // disabled control (e.g. Offline wallet cards use disabled:pointer-events-none).
        return (
            <Tooltip content={info} side={side}>
                <div className="pointer-events-auto">{pill}</div>
            </Tooltip>
        );
    }
    return pill;
}
