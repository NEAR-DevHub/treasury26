import {
    ArrowDataTransferHorizontalIcon,
    ArrowDown03Icon,
    Award01Icon,
    CheckmarkSquare01Icon,
    CircleArrowUp01Icon,
    Clock01Icon,
    DatabaseIcon,
    FactoryIcon,
    FileAttachmentIcon,
    SentIcon,
    Settings01Icon,
    Shield01Icon,
    SourceCodeSquareIcon,
    UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { TreasuryTypeIcon } from "@/components/icons/shield";
import type { Proposal } from "@/lib/proposals-api";
import { extractConfidentialRequestData } from "../utils/proposal-extractors";
import { getProposalUIKind } from "../utils/proposal-utils";

interface ProposalTypeIconProps {
    proposal: Proposal;
    treasuryId?: string;
    className?: string;
}

function PaymentIcon() {
    return (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-blue-500/10 bg-blue-100">
            <Icon
                icon={SentIcon}
                className="shrink-0 dark:text-blue-300 text-blue-800"
            />
        </div>
    );
}

function ExchangeIcon() {
    return (
        <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-pink-500/10 bg-pink-100">
            <Icon
                icon={ArrowDataTransferHorizontalIcon}
                className="shrink-0 dark:text-pink-300 text-pink-800"
            />
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
        case "Confidential Request": {
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
        }
        case "Function Call":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-blue-500/10 bg-blue-100">
                    <Icon
                        icon={SourceCodeSquareIcon}
                        className="shrink-0 dark:text-blue-400 text-blue-800"
                    />
                </div>
            );
        case "Change Policy":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-amber-500/10 bg-amber-100">
                    <Icon
                        icon={Shield01Icon}
                        className="shrink-0 dark:text-amber-300 text-amber-800"
                    />
                </div>
            );
        case "Vesting":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-indigo-500/10 bg-indigo-100">
                    <Icon
                        icon={Clock01Icon}
                        className="shrink-0 dark:text-indigo-300 text-indigo-800"
                    />
                </div>
            );
        case "Earn NEAR":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-green-500/10 bg-green-100">
                    <Icon
                        icon={DatabaseIcon}
                        className="shrink-0 dark:text-green-300 text-green-700"
                    />
                </div>
            );
        case "Unstake NEAR":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-orange-500/10 bg-orange-100">
                    <Icon
                        icon={ArrowDown03Icon}
                        className="shrink-0 dark:text-orange-300 text-orange-800"
                    />
                </div>
            );
        case "Withdraw Earnings":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-green-500/10 bg-green-100">
                    <Icon
                        icon={ArrowDown03Icon}
                        className="shrink-0 dark:text-green-300 text-green-700"
                    />
                </div>
            );
        case "Exchange":
            return <ExchangeIcon />;
        case "Update General Settings":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-gray-500/10 bg-gray-100">
                    <Icon
                        icon={Settings01Icon}
                        className="shrink-0 dark:text-gray-400 text-gray-800"
                    />
                </div>
            );
        case "Members":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-purple-500/10 bg-purple-100">
                    <Icon
                        icon={UserGroupIcon}
                        className="shrink-0 dark:text-purple-300 text-purple-800"
                    />
                </div>
            );
        case "Upgrade":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-cyan-500/10 bg-cyan-100">
                    <Icon
                        icon={CircleArrowUp01Icon}
                        className="shrink-0 dark:text-cyan-300 text-cyan-800"
                    />
                </div>
            );
        case "Set Staking Contract":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-green-500/10 bg-green-100">
                    <Icon
                        icon={DatabaseIcon}
                        className="shrink-0 dark:text-green-300 text-green-700"
                    />
                </div>
            );
        case "Bounty":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-yellow-500/10 bg-yellow-100">
                    <Icon
                        icon={Award01Icon}
                        className="shrink-0 dark:text-yellow-300 text-yellow-800"
                    />
                </div>
            );
        case "Vote":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-teal-500/10 bg-teal-100">
                    <Icon
                        icon={CheckmarkSquare01Icon}
                        className="shrink-0 dark:text-teal-300 text-teal-800"
                    />
                </div>
            );
        case "Factory Info Update":
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-slate-500/10 bg-slate-100">
                    <Icon
                        icon={FactoryIcon}
                        className="shrink-0 dark:text-slate-400 text-slate-800"
                    />
                </div>
            );
        default:
            return (
                <div className="flex size-9 shrink-0 items-center justify-center rounded-full dark:bg-gray-500/10 bg-gray-100">
                    <Icon
                        icon={FileAttachmentIcon}
                        className="shrink-0 dark:text-gray-400 text-gray-800"
                    />
                </div>
            );
    }
}
