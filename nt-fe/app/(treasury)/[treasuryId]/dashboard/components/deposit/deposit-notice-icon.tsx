import { Check, Info, X } from "lucide-react";

export type DepositNoticeTone = "success" | "danger" | "info";

export function DepositNoticeIcon({ tone }: { tone: DepositNoticeTone }) {
    if (tone === "success") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-success-foreground flex items-center justify-center">
                <Check className="size-2.5 text-white stroke-3" />
            </span>
        );
    }
    if (tone === "danger") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-destructive-foreground flex items-center justify-center">
                <X className="size-2.5 text-white stroke-3" />
            </span>
        );
    }
    return <Info className="size-4 shrink-0 mt-0.5 text-muted-foreground" />;
}
