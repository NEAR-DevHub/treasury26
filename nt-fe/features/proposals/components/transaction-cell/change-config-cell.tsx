import { ChangeConfigData } from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface ChangeConfigCellProps {
    data: ChangeConfigData;
    timestamp?: string;
    textOnly?: boolean;
}

export function ChangeConfigCell({ data, timestamp }: ChangeConfigCellProps) {
    const changesCount = [
        data.oldConfig.name !== data.newConfig.name,
        data.oldConfig.purpose !== data.newConfig.purpose,
        ...Object.keys({ ...data.oldConfig.metadata, ...data.newConfig.metadata }).map(
            key => (data.oldConfig.metadata?.[key] ?? null) !== (data.newConfig.metadata?.[key] ?? null)
        )
    ].filter(Boolean).length;

    const subtitle = `${changesCount} ${changesCount === 1 ? 'Change' : 'Changes'}`;

    return (
        <TitleSubtitleCell
            title="General Update"
            subtitle={subtitle}
            timestamp={timestamp}
        />
    );
}
