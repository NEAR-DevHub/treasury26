import { InfoDisplay, InfoItem } from "@/components/info-display";
import { ChangeConfigData } from "../../types/index";
import { isNullValue, renderDiff } from "../../utils/diff-utils";

interface ChangeConfigExpandedProps {
    data: ChangeConfigData;
}

export function ChangeConfigExpanded({ data }: ChangeConfigExpandedProps) {
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

    if (data.oldConfig.name !== data.newConfig.name) {
        infoItems.push({
            label: "Name",
            value: configDiff("name", data.oldConfig.name, data.newConfig.name)
        });
    }

    if (data.oldConfig.purpose !== data.newConfig.purpose) {
        infoItems.push({
            label: "Purpose",
            value: configDiff("purpose", data.oldConfig.purpose, data.newConfig.purpose)
        });
    }

    const allMetadataKeys = Array.from(new Set([
        ...Object.keys(data.oldConfig.metadata || {}),
        ...Object.keys(data.newConfig.metadata || {})
    ]));

    for (const key of allMetadataKeys) {
        const oldValue = data.oldConfig.metadata?.[key] ?? null;
        const newValue = data.newConfig.metadata[key] ?? null;

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
                No changes detected in configuration.
            </div>
        );
    }

    return (
        <InfoDisplay items={infoItems} />
    );
}
