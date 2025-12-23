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
        if (key === "primaryColor") {
            infoItems.push({
                label: key,
                value: <div className="w-5 h-5 rounded-full" style={{ backgroundColor: data.metadata[key] }}></div>
            });
        } else if (key === "flagLogo") {
            infoItems.push({
                label: key,
                value: <img src={data.metadata[key]} alt="Flag Logo" className="w-5 h-5 rounded-md" />
            });
        } else {
            infoItems.push({
                label: key,
                value: <span>{data.metadata[key]}</span>
            });
        }
    }

    return (
        <InfoDisplay items={infoItems} />
    );
}
