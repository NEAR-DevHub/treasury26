import { ConfidentialRequestData } from "../../types/index";
import { SwapExpanded } from "./swap-expanded";
import { TransferExpanded } from "./transfer-expanded";
import { ConfidentialState } from "@/components/confidential-state";
import { Skeleton } from "@/components/ui/skeleton";
import { useRequestDisplayContext } from "./common/request-display-context";

interface ConfidentialTransferExpandedProps {
    data: ConfidentialRequestData;
}

export function ConfidentialRequestExpanded({
    data,
}: ConfidentialTransferExpandedProps) {
    const requestDisplayContext = useRequestDisplayContext();
    const isExecuted = requestDisplayContext?.isExecuted ?? false;
    const mapped = data.mapped;

    if (!mapped) {
        return (
            <ConfidentialState
                skeleton={
                    <div className="flex flex-col gap-2">
                        <Skeleton className="h-[60px] w-full" />
                        <Skeleton className="h-[60px] w-full" />
                        <Skeleton className="h-[60px] w-full" />
                    </div>
                }
            />
        );
    }

    if (mapped.type === "swap") {
        return <SwapExpanded data={mapped.data} isExecuted={isExecuted} />;
    }

    return <TransferExpanded data={mapped.data} />;
}
