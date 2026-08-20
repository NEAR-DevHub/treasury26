import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    InformationCircleIcon,
    Tick01Icon,
} from "@hugeicons/core-free-icons";

export type DepositNoticeTone = "success" | "danger" | "info";

export function DepositNoticeIcon({ tone }: { tone: DepositNoticeTone }) {
    if (tone === "success") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-success-foreground flex items-center justify-center">
                <Icon
                    icon={Tick01Icon}
                    className="size-2.5 text-white stroke-3"
                />
            </span>
        );
    }
    if (tone === "danger") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-destructive-foreground flex items-center justify-center">
                <Icon
                    icon={Cancel01Icon}
                    className="size-2.5 text-white stroke-3"
                />
            </span>
        );
    }
    return (
        <Icon
            icon={InformationCircleIcon}
            className="shrink-0 mt-0.5 text-muted-foreground"
        />
    );
}
