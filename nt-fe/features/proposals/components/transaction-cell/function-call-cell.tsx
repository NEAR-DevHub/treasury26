import { useTranslations } from "next-intl";
import { FunctionCallData } from "../../types/index";
import { TitleSubtitleCell } from "./title-subtitle-cell";

interface FunctionCallCellProps {
    data: FunctionCallData;
    timestamp?: string;
    textOnly?: boolean;
}

export function FunctionCallCell({ data, timestamp }: FunctionCallCellProps) {
    const t = useTranslations("proposals.expanded");
    const subtitle = t("onReceiver", { receiver: data.receiver });
    const title =
        data.actions.length === 1
            ? data.actions[0].methodName
            : t("actionsCount", { count: data.actions.length });

    return (
        <TitleSubtitleCell
            title={title}
            subtitle={subtitle}
            timestamp={timestamp}
        />
    );
}
