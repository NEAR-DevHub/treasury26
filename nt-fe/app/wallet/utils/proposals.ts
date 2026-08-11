import type { Proposal, ProposalKind } from "@/lib/proposals-api";
import { jsonToBase64 } from "@/lib/utils";
import type {
    ProposalData,
    TransactionRequest,
    WalletProposalLabels,
} from "./types";

export function translateToProposals(
    daoId: string,
    tx: TransactionRequest,
    labels: WalletProposalLabels,
): ProposalData[] {
    const proposals: ProposalData[] = [];
    const functionCallActions: TransactionRequest["actions"] = [];

    for (const action of tx.actions) {
        switch (action.type) {
            case "Transfer":
                proposals.push({
                    receiverId: daoId,
                    description: labels.transferDescription(tx.receiverId),
                    kind: {
                        Transfer: {
                            msg: null,
                            amount: action.params.deposit,
                            token_id: "",
                            receiver_id: tx.receiverId,
                        },
                    },
                });
                break;

            case "FunctionCall":
                functionCallActions.push(action);
                break;

            default:
                throw new Error(labels.unsupportedAction(action.type));
        }
    }

    // Group all FunctionCall actions into a single FunctionCall proposal
    if (functionCallActions.length > 0) {
        const actions = functionCallActions.map((a) => ({
            method_name: a.params.methodName,
            args: jsonToBase64(a.params.args),
            gas: a.params.gas,
            deposit: a.params.deposit,
        }));

        proposals.push({
            receiverId: daoId,
            description: labels.functionCallDescription(
                functionCallActions.map((a) => a.params.methodName).join(", "),
                tx.receiverId,
            ),
            kind: {
                FunctionCall: {
                    receiver_id: tx.receiverId,
                    actions,
                },
            },
        });
    }

    return proposals;
}

export function toSyntheticProposal(proposalData: ProposalData): Proposal {
    return {
        id: 0,
        description: proposalData.description,
        kind: proposalData.kind as ProposalKind,
        status: "InProgress",
        proposer: "",
        submission_time: "0",
        vote_counts: {},
        votes: {},
        last_actions_log: null,
    };
}
