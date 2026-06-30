import {
    FileText,
    Shield,
    Clock,
    CreditCard,
    TerminalSquare,
    Database,
    ArrowDownToLine,
    Settings,
    ArrowRightLeft,
} from "lucide-react";
import { Proposal } from "@/lib/proposals-api";
import { getProposalUIKind } from "../utils/proposal-utils";
import { TreasuryTypeIcon } from "@/components/icons/shield";
import { extractConfidentialRequestData } from "../utils/proposal-extractors";

interface ProposalTypeIconProps {
    proposal: Proposal;
    treasuryId?: string;
    className?: string;
}

function PaymentIcon() {
    return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-blue-500/10 bg-blue-100">
            <CreditCard className="size-5 shrink-0 dark:text-blue-300 text-blue-800" />
        </div>
    );
}

function ExchangeIcon() {
    return (
        <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-pink-500/10 bg-pink-100">
            <ArrowRightLeft className="size-5 shrink-0 dark:text-pink-300 text-pink-800" />
        </div>
    );
}

export function ProposalTypeIcon({
    proposal,
    treasuryId,
}: ProposalTypeIconProps) {
    const type = getProposalUIKind(proposal);

    switch (type) {
        case "Payment Request":
        case "Batch Payment Request":
            return <PaymentIcon />;
        case "Confidential Request":
            const extract = extractConfidentialRequestData(
                proposal,
                treasuryId,
            );
            const mappedType = extract.mapped?.type;

            if (mappedType === "payment" || mappedType === "bulk") {
                return <PaymentIcon />;
            } else if (mappedType) {
                return <ExchangeIcon />;
            } else {
                return <TreasuryTypeIcon type="confidential" />;
            }
        case "Function Call":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-blue-500/10 bg-blue-100">
                    <TerminalSquare className="size-5 shrink-0 dark:text-blue-400 text-blue-800" />
                </div>
            );
        case "Change Policy":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-amber-500/10 bg-amber-100">
                    <Shield className="size-5 shrink-0 dark:text-amber-300 text-amber-800" />
                </div>
            );
        case "Vesting":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-indigo-500/10 bg-indigo-100">
                    <Clock className="size-5 shrink-0 dark:text-indigo-300 text-indigo-800" />
                </div>
            );
        case "Earn NEAR":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-green-500/10 bg-green-100">
                    <Database className="size-5 shrink-0 dark:text-green-300 text-green-700" />
                </div>
            );
        case "Unstake NEAR":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-orange-500/10 bg-orange-100">
                    <ArrowDownToLine className="size-5 shrink-0 dark:text-orange-300 text-orange-800" />
                </div>
            );
        case "Withdraw Earnings":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-green-500/10 bg-green-100">
                    <ArrowDownToLine className="size-5 shrink-0 dark:text-green-300 text-green-700" />
                </div>
            );
        case "Exchange":
            return <ExchangeIcon />;
        case "Update General Settings":
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-gray-500/10 bg-gray-100">
                    <Settings className="size-5 shrink-0 dark:text-gray-400 text-gray-800" />
                </div>
            );
        default:
            return (
                <div className="flex h-8 w-8 items-center justify-center rounded-full dark:bg-gray-500/10 bg-gray-100">
                    <FileText className="size-5 shrink-0 dark:text-gray-400 text-gray-800" />
                </div>
            );
    }
}
