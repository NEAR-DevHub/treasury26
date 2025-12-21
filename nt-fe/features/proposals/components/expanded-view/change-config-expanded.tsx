import { InfoDisplay, InfoItem } from "@/components/info-display";
import { ChangeConfigData } from "../../types/index";

interface ChangeConfigExpandedProps {
    data: ChangeConfigData;
}

export function ChangeConfigExpanded({ data }: ChangeConfigExpandedProps) {
    let infoItems: InfoItem[] = [
        {
            label: "Name",
            value: <span>{data.name}</span>
        },
        {
            label: "Purpose",
            value: <span>{data.purpose}</span>,
        },
    ];

    for (const key in data.metadata) {
        infoItems.push({
            label: key,
            value: <span>{data.metadata[key]}</span>
        });
    }

    return (
        <InfoDisplay items={infoItems} />
    );
}
