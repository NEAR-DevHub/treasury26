import { InfoDisplay, InfoItem } from "@/components/info-display";
import { ChangeConfigData } from "../../types/index";
import { isNullValue, renderDiff } from "../../utils/diff-utils";
import { Proposal } from "@/lib/proposals-api";
import { Policy } from "@/types/policy";
import { TreasuryConfig } from "@/lib/api";
import { getProposalStatus } from "../../utils/proposal-utils";
import { useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { computeConfigDiff } from "../../utils/config-diff-utils";
import { useMemo } from "react";
import { Loader2 } from "lucide-react";

interface ChangeConfigExpandedProps {
    data: ChangeConfigData;
    proposal: Proposal;
}

export function ChangeConfigExpanded({ data, proposal }: ChangeConfigExpandedProps) {
    const { selectedTreasury } = useTreasury();

    const isPending = proposal.status === "InProgress";

    // If not pending, fetch the config at the time of submission
    const { data: daoConfig, isLoading: isLoadingTimestamped } = useTreasuryConfig(
        selectedTreasury,
        !isPending ? proposal.submission_time : null
    );

    const oldConfig = daoConfig;
    const diff = useMemo(() => {
        // Prepare the old config format expected by computeConfigDiff
        const formattedOldConfig = oldConfig ? {
            name: oldConfig?.name ?? null,
            purpose: oldConfig?.purpose ?? null,
            metadata: (oldConfig?.metadata as any) || {}
        } : null;

        return computeConfigDiff(formattedOldConfig, data.newConfig);
    }, [oldConfig, data, isPending]);

    if (!isPending && isLoadingTimestamped) {
        return (
            <div className="flex items-center justify-center p-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                <span className="ml-2 text-muted-foreground text-sm">Loading historical configuration...</span>
            </div>
        );
    }

    let infoItems: InfoItem[] = [];

    const formatValue = (key: string, val: any) => {
        if (isNullValue(val)) return <span className="text-muted-foreground/50">null</span>;
        if (key === "primaryColor") {
            return <div className="w-5 h-5 rounded-full border inline-block align-middle" style={{ backgroundColor: val }}></div>;
        }
        if (key === "flagLogo") {
            return <img src={val} alt="Logo" className="w-5 h-5 rounded-md object-cover inline-block align-middle" />;
        }
        return <span>{String(val)}</span>;
    };

    const configDiff = (key: string, oldValue: any, newValue: any) =>
        renderDiff(formatValue(key, oldValue), formatValue(key, newValue), isNullValue(oldValue));

    if (diff.nameChanged) {
        infoItems.push({
            label: "Name",
            value: configDiff("name", diff.oldConfig.name, diff.newConfig.name)
        });
    }

    if (diff.purposeChanged) {
        infoItems.push({
            label: "Purpose",
            value: configDiff("purpose", diff.oldConfig.purpose, diff.newConfig.purpose)
        });
    }

    const allMetadataKeys = Array.from(new Set([
        ...Object.keys(diff.oldConfig.metadata || {}),
        ...Object.keys(diff.newConfig.metadata || {})
    ]));

    for (const key of allMetadataKeys) {
        const oldValue = diff.oldConfig.metadata?.[key] ?? null;
        const newValue = diff.newConfig.metadata[key] ?? null;

        if (oldValue !== newValue) {
            let label = key.replace(/([A-Z])/g, ' $1').replace(/^./, str => str.toUpperCase());
            if (key === "flagLogo") label = "Logo";

            infoItems.push({
                label,
                value: configDiff(key, oldValue, newValue)
            });
        }
    }

    if (infoItems.length === 0) {
        return (
            <div className="p-4 text-center text-muted-foreground">
                No changes detected in configuration compared to the {isPending ? "current" : "historical"} state.
            </div>
        );
    }

    return (
        <InfoDisplay items={infoItems} />
    );
}
