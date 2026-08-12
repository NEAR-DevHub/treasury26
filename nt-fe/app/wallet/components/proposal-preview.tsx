import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { FunctionCallExpanded } from "@/features/proposals/components/expanded-view/function-call-expanded";
import { TransferExpanded } from "@/features/proposals/components/expanded-view/transfer-expanded";
import type {
    FunctionCallData,
    PaymentRequestData,
} from "@/features/proposals/types/index";
import { extractProposalData } from "@/features/proposals/utils/proposal-extractors";
import { toSyntheticProposal } from "../utils/proposals";
import type { ProposalData } from "../utils/types";

export function ProposalPreview({
    proposalData,
    index,
}: {
    proposalData: ProposalData;
    index: number;
}) {
    const tKinds = useTranslations("proposalKinds");
    const synthetic = toSyntheticProposal(proposalData);
    const { type, data } = extractProposalData(synthetic);

    let body: ReactNode = null;
    switch (type) {
        case "Payment Request":
            body = <TransferExpanded data={data as PaymentRequestData} />;
            break;
        case "Function Call":
            body = <FunctionCallExpanded data={data as FunctionCallData} />;
            break;
    }

    return (
        <div>
            <p className="text-sm font-semibold mb-3">
                {index + 1}. {tKinds(type)}
            </p>
            {body}
        </div>
    );
}
