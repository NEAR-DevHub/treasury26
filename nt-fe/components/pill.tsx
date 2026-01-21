import { cn } from "@/lib/utils";
import { Tooltip } from "./tooltip";
import { Info } from "lucide-react";

interface PillProps {
    title: string;
    info?: string;
    variant?: "default" | "secondary" | "info";
    side?: "top" | "bottom" | "left" | "right";
}

const variants = {
    default: "",
    secondary: "bg-card text-card-foreground",
    info: "bg-general-info-background-faded border border-general-info-border text-general-info-foreground",
}

export function Pill({ title, info, variant = "default", side }: PillProps) {
    return (
        <div className={cn("flex border rounded-md items-center py-[3px] px-2 gap-1.5 w-fit text-xs font-medium text-center", variants[variant])}>
            {title}
            {info && <Tooltip content={info} side={side}>
                <Info className="size-3 shrink-0" />
            </Tooltip>}
        </div>
    )
}
