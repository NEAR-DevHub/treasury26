import { TitleSubtitleCell } from "./title-subtitle-cell";
import { Proposal } from "@/lib/proposals-api";
import { getProposalStatus } from "../../utils/proposal-utils";
import { useTreasuryConfig } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { extractChangeConfigData } from "../../utils/proposal-extractors";
import { computeConfigDiff } from "../../utils/config-diff-utils";
import { useMemo } from "react";

interface ChangeConfigCellProps {
    proposal: Proposal;
    timestamp?: string;
    textOnly?: boolean;
}

export function ChangeConfigCell({ proposal, timestamp }: ChangeConfigCellProps) {
    const { selectedTreasury } = useTreasury();

    const isPending = proposal.status === "InProgress";

    // If not pending, fetch the config at the time of submission
    const { data: oldConfig, isLoading: isLoadingTimestamped } = useTreasuryConfig(
        selectedTreasury,
        !isPending ? proposal.submission_time : null
    );

    const summary = useMemo(() => {
        if (!oldConfig) return null;

        const { newConfig } = extractChangeConfigData(proposal);

        // Prepare the old config format expected by computeConfigDiff
        const formattedOldConfig = {
            name: oldConfig.name ?? null,
            purpose: oldConfig.purpose ?? null,
            metadata: (oldConfig.metadata as any) || {}
        };

        const diff = computeConfigDiff(formattedOldConfig, newConfig);
        return {
            changesCount: diff.changesCount
        };
    }, [oldConfig, proposal]);

    if (isLoadingTimestamped) {
        return (
            <TitleSubtitleCell
                title="Loading config..."
                subtitle="Historical data..."
                timestamp={timestamp}
            />
        );
    }

    if (!summary) {
        return (
            <TitleSubtitleCell
                title="General Update"
                subtitle="Details unavailable"
                timestamp={timestamp}
            />
        );
    }

    const { changesCount } = summary;
    const subtitle = `${changesCount} ${changesCount === 1 ? 'Change' : 'Changes'}`;

    return (
        <TitleSubtitleCell
            title="General Update"
            subtitle={subtitle}
            timestamp={timestamp}
        />
    );
}
