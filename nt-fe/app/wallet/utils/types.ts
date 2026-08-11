export type WalletAction = "sign_in" | "sign_transactions";

export type WalletStep =
    | "connect"
    | "select-treasury"
    | "confirm-transactions"
    | "processing"
    | "waiting-approval"
    | "done"
    | "error";

export interface Treasury {
    daoId: string;
    config: {
        name?: string;
        purpose?: string;
        metadata?: { flagLogo?: string };
    };
    isMember: boolean;
}

export interface TransactionRequest {
    receiverId: string;
    actions: Array<{
        type: string;
        params: {
            methodName: string;
            args: any;
            gas: string;
            deposit: string;
        };
    }>;
}

export interface ProposalData {
    receiverId: string;
    description: string;
    kind: any;
}

export interface WalletProposalLabels {
    transferDescription: (receiverId: string) => string;
    functionCallDescription: (methods: string, receiverId: string) => string;
    unsupportedAction: (type: string) => string;
}
