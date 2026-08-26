import { Icon } from "@/components/icon";
import { Cancel01Icon, CheckIcon, InfoIcon } from "@hugeicons/core-free-icons";

export type DepositNoticeTone = "success" | "danger" | "info";

const glyphClassName = "size-2.5 text-card stroke-3";

export function DepositNoticeIcon({ tone }: { tone: DepositNoticeTone }) {
    if (tone === "success") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-success-foreground flex items-center justify-center">
                <Icon icon={CheckIcon} className={glyphClassName} />
            </span>
        );
    }
    if (tone === "danger") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-error-icon flex items-center justify-center">
                <Icon icon={Cancel01Icon} className={glyphClassName} />
            </span>
        );
    }
    return (
        <Icon
            icon={InfoIcon}
            className="size-4 shrink-0 mt-0.5 text-card [&_circle]:fill-general-info-icon [&_circle]:stroke-general-info-icon"
        />
    );
}
