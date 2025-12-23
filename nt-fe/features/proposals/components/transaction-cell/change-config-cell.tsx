import { ChangeConfigData } from "../../types/index";

interface ChangeConfigCellProps {
    data: ChangeConfigData;
}

export function ChangeConfigCell({ data }: ChangeConfigCellProps) {
    return (
        <div className="flex flex-col gap-1">
            <span className="font-medium">General Update</span>
            <span className="text-xs text-muted-foreground">
                X Changes
            </span>
        </div>
    );
}
