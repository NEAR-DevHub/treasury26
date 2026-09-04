"use client";

import { useEffect } from "react";
import { useTranslations } from "next-intl";

export interface NearStoreMessages {
    connectAndAcceptTerms: string;
    transactionNotApproved: string;
    failedSubmitVote: string;
    failedSubmitVotes: string;
    viewRequest: string;
    proposalRemoved: string;
    voteSubmitted: string;
    votesSubmitted: string;
}

const fallback: NearStoreMessages = {
    connectAndAcceptTerms:
        "Please connect wallet and accept terms to continue.",
    transactionNotApproved: "Transaction wasn't approved in your wallet.",
    failedSubmitVote: "Failed to submit vote",
    failedSubmitVotes: "Failed to submit votes",
    viewRequest: "View request",
    proposalRemoved: "Your proposal has been removed",
    voteSubmitted: "Your vote has been submitted",
    votesSubmitted: "Your votes have been submitted",
};

let current: Readonly<NearStoreMessages> = Object.freeze(fallback);

export function getNearStoreMessages(): Readonly<NearStoreMessages> {
    return current;
}

export function useSyncNearStoreMessages() {
    const t = useTranslations("nearStore");
    useEffect(() => {
        current = Object.freeze({
            connectAndAcceptTerms: t("connectAndAcceptTerms"),
            transactionNotApproved: t("transactionNotApproved"),
            failedSubmitVote: t("failedSubmitVote"),
            failedSubmitVotes: t("failedSubmitVotes"),
            viewRequest: t("viewRequest"),
            proposalRemoved: t("proposalRemoved"),
            voteSubmitted: t("voteSubmitted"),
            votesSubmitted: t("votesSubmitted"),
        });
    }, [t]);
}
