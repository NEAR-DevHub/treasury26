"use client";

import { createContext, useContext } from "react";
import type { UIProposalStatus } from "@/features/proposals/utils/proposal-utils";

interface RequestDisplayContextValue {
    showUSDValue: boolean;
    isConfidential: boolean;
    proposalStatus: UIProposalStatus;
    isPending: boolean;
    isExecuted: boolean;
}

const RequestDisplayContext = createContext<RequestDisplayContextValue | null>(
    null,
);

export function RequestDisplayProvider({
    value,
    children,
}: {
    value: RequestDisplayContextValue;
    children: React.ReactNode;
}) {
    return (
        <RequestDisplayContext.Provider value={value}>
            {children}
        </RequestDisplayContext.Provider>
    );
}

export function useRequestDisplayContext() {
    return useContext(RequestDisplayContext);
}
