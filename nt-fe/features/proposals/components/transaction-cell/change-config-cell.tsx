import { ChangeConfigData } from "../../types/index";

interface ChangeConfigCellProps {
    data: ChangeConfigData;
}

export function ChangeConfigCell({ data }: ChangeConfigCellProps) {
    const changesCount = [
        data.oldConfig.name !== data.newConfig.name,
        data.oldConfig.purpose !== data.newConfig.purpose,
        ...Object.keys({ ...data.oldConfig.metadata, ...data.newConfig.metadata }).map(
            key => (data.oldConfig.metadata?.[key] ?? null) !== (data.newConfig.metadata?.[key] ?? null)
        )
    ].filter(Boolean).length;

    return (
        <div className="flex flex-col gap-1">
            <span className="font-medium">General Update</span>
            <span className="text-xs text-muted-foreground">
                {changesCount} {changesCount === 1 ? 'Change' : 'Changes'}
            </span>
        </div>
    );
}
