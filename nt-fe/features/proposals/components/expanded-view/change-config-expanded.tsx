import { InfoDisplay, InfoItem } from "@/components/info-display";
import { Proposal } from "@/lib/proposals-api";
import { decodeArgs } from "@/lib/utils";

interface ChangeConfigExpandedProps {
    proposal: Proposal;
}

export function ChangeConfigExpanded({ proposal }: ChangeConfigExpandedProps) {
    if (!('ChangeConfig' in proposal.kind)) return null;
    const changeConfig = proposal.kind.ChangeConfig;
    const { metadata, purpose, name } = changeConfig.config;
    const metadataFromBase64 = decodeArgs(metadata);

    let infoItems: InfoItem[] = [
        {
            label: "Name",
            value: name
        },
        {
            label: "Purpose",
            value: purpose,
        },
    ];

    for (const key in metadataFromBase64) {
        infoItems.push({
            label: key,
            value: metadataFromBase64[key]
        });
    }
    return (
        <InfoDisplay items={infoItems} />
    );
}
