import { useTranslations } from "next-intl";
import { InfoDisplay, InfoItem } from "@/components/info-display";
import { ChangeConfigData } from "../../types/index";
import { isNullValue, renderDiff } from "../../utils/diff-utils";
import { Proposal } from "@/lib/proposals-api";
import { useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { computeConfigDiff } from "../../utils/config-diff-utils";
import { useMemo } from "react";
import { Loader2 } from "lucide-react";
import { useRequestDisplayContext } from "./common/request-display-context";

interface ChangeConfigExpandedProps {
    data: ChangeConfigData;
    proposal: Proposal;
}

export function ChangeConfigExpanded({
    data,
    proposal,
}: ChangeConfigExpandedProps) {
    const t = useTranslations("proposals.expanded");
    const { treasuryId } = useTreasury();
    const requestDisplayContext = useRequestDisplayContext()!;

    const isPending = requestDisplayContext.isPending;

    // If not pending, fetch the config at the time of submission
    const { data: daoConfig, isLoading: isLoadingTimestamped } =
        useTreasuryConfig(
            treasuryId,
            !isPending ? proposal.submission_time : null,
        );

    const oldConfig = daoConfig;
    const diff = useMemo(() => {
        // Prepare the old config format expected by computeConfigDiff
        const formattedOldConfig = oldConfig
            ? {
                  name: oldConfig?.name ?? null,
                  purpose: oldConfig?.purpose ?? null,
                  metadata: (oldConfig?.metadata as any) || {},
              }
            : null;

        return computeConfigDiff(formattedOldConfig, data.newConfig);
    }, [oldConfig, data, isPending]);

    if (!isPending && isLoadingTimestamped) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground text-sm">
                    {t("loadingHistorical")}
                </span>
            </div>
        );
    }

    let infoItems: InfoItem[] = [];

    const formatValue = (key: string, val: any) => {
        if (isNullValue(val))
            return (
                <span className="text-muted-foreground/50">{t("notSet")}</span>
            );
        if (key === "primaryColor") {
            return (
                <div
                    className="w-5 h-5 rounded-full border inline-block align-middle"
                    style={{ backgroundColor: val }}
                ></div>
            );
        }
        if (key === "flagLogo") {
            return (
                <img
                    src={val}
                    alt={t("logoAlt")}
                    className="w-5 h-5 rounded-md object-cover inline-block align-middle"
                />
            );
        }
        // Handle objects and arrays
        if (typeof val === "object" && val !== null) {
            return (
                <pre className="text-xs bg-muted/30 p-2 rounded-md overflow-x-auto max-w-md">
                    {JSON.stringify(val, null, 2)}
                </pre>
            );
        }
        return <span>{String(val)}</span>;
    };

    const configDiff = (key: string, oldValue: any, newValue: any) =>
        renderDiff(
            formatValue(key, oldValue),
            formatValue(key, newValue),
            isNullValue(oldValue),
        );

    if (diff.nameChanged) {
        infoItems.push({
            label: t("name"),
            value: configDiff("name", diff.oldConfig.name, diff.newConfig.name),
        });
    }

    if (diff.purposeChanged) {
        infoItems.push({
            label: t("purpose"),
            value: configDiff(
                "purpose",
                diff.oldConfig.purpose,
                diff.newConfig.purpose,
            ),
        });
    }

    const allMetadataKeys = Array.from(
        new Set([
            ...Object.keys(diff.oldConfig.metadata || {}),
            ...Object.keys(diff.newConfig.metadata || {}),
        ]),
    );

    for (const key of allMetadataKeys) {
        const oldValue = diff.oldConfig.metadata?.[key] ?? null;
        const newValue = diff.newConfig.metadata[key] ?? null;

        if (oldValue !== newValue) {
            const knownMetadataLabels: Record<string, string> = {
                flagLogo: t("logo"),
                primaryColor: t("primaryColor"),
            };
            const label =
                knownMetadataLabels[key] ??
                key
                    .replace(/([A-Z])/g, " $1")
                    .replace(/^./, (str) => str.toUpperCase());

            infoItems.push({
                label,
                value: configDiff(key, oldValue, newValue),
            });
        }
    }

    if (infoItems.length === 0) {
        return (
            <div className="p-4 text-center text-muted-foreground">
                {isPending ? t("noChangesCurrent") : t("noChangesHistorical")}
            </div>
        );
    }

    return <InfoDisplay items={infoItems} />;
}
