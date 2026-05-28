import { ConfidentialRequestData } from "../../types/index";
import { TokenCell } from "./token-cell";
import { SwapCell } from "./swap-cell";
import { Skeleton } from "@/components/ui/skeleton";

interface ConfidentialTransferCellProps {
    data: ConfidentialRequestData;
    timestamp?: string;
    subtitleSuffix?: React.ReactNode;
    textOnly?: boolean;
}

export function ConfidentialRequestCell({
    data,
    timestamp,
    subtitleSuffix,
    textOnly = false,
}: ConfidentialTransferCellProps) {
    const mapped = data.mapped;

    if (!mapped) {
        return <Skeleton className="h-5 w-36 animate-none" />;
    }

    if (mapped.type === "swap") {
        return (
            <SwapCell
                data={mapped.data}
                subtitleSuffix={subtitleSuffix}
                timestamp={timestamp}
                textOnly={textOnly}
            />
        );
    }

    return (
        <TokenCell
            data={mapped.data}
            subtitleSuffix={subtitleSuffix}
            timestamp={timestamp}
            textOnly={textOnly}
        />
    );
}
