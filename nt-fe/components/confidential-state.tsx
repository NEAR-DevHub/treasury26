"use client";
import { Icon } from "@/components/icon";
import { Shield01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { EmptyState } from "./empty-state";

export function ConfidentialState({
    skeleton,
}: {
    skeleton?: React.ReactNode;
}) {
    const t = useTranslations("confidentialState");
    return (
        <div className="relative **:data-[slot=skeleton]:animate-none!">
            {skeleton}
            <div className="absolute left-1/2 -translate-x-1/2 top-1/2 -translate-y-1/2">
                <EmptyState
                    icon={<Icon icon={Shield01Icon} className="text-white" />}
                    title={t("title")}
                    description={t("description")}
                    className="py-0"
                    iconWrapperClassName="size-10 bg-black"
                    descriptionClassName="whitespace-nowrap"
                />
            </div>
        </div>
    );
}
