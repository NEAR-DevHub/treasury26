import { Icon } from "@/components/icon";
import { Cancel01Icon, CheckIcon, InfoIcon } from "@hugeicons/core-free-icons";

export type DepositNoticeTone = "success" | "danger" | "info";

export function DepositNoticeIcon({ tone }: { tone: DepositNoticeTone }) {
    if (tone === "success") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-success-foreground flex items-center justify-center">
                <Icon
                    icon={CheckIcon}
                    className="size-2.5 text-white stroke-3"
                />
            </span>
        );
    }
    if (tone === "danger") {
        return (
            <span className="size-4 shrink-0 mt-0.5 rounded-full bg-general-error-icon flex items-center justify-center">
                <Icon
                    icon={Cancel01Icon}
                    className="size-2.5 text-white stroke-3"
                />
            </span>
        );
    }
    // Fill the circle only — keep InfoIcon so it matches the other notice glyphs.
    return (
        <Icon
            icon={InfoIcon}
            className="size-4 shrink-0 mt-0.5 text-white [&_circle]:fill-general-info-icon [&_circle]:stroke-general-info-icon"
        />
    );
}
