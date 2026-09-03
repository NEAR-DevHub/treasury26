import {
    ArrowDataTransferHorizontalIcon,
    ArrowDown03Icon,
    Award01Icon,
    CheckmarkSquare01Icon,
    CircleArrowUp01Icon,
    Clock01Icon,
    DatabaseIcon,
    FactoryIcon,
    File01Icon,
    SentIcon,
    Settings01Icon,
    Shield01Icon,
    SourceCodeSquareIcon,
    UserGroupIcon,
} from "@hugeicons/core-free-icons";
import { Icon } from "@/components/icon";
import { TreasuryTypeIcon } from "@/components/icons/shield";
import type { Proposal } from "@/lib/proposals-api";
import { cn } from "@/lib/utils";
import { extractConfidentialRequestData } from "../utils/proposal-extractors";
import { getProposalUIKind } from "../utils/proposal-utils";

interface ProposalTypeIconProps {
    proposal: Proposal;
    treasuryId?: string;
    className?: string;
}

/** The circle every request type shares — only the tint differs. */
const TYPE_ICON_CLASS =
    "flex size-9 shrink-0 items-center justify-center rounded-full border";

function PaymentIcon() {
    return (
        <div
            className={cn(
                TYPE_ICON_CLASS,
                "border-general-blue-border bg-general-blue-background-faded",
            )}
        >
            <Icon
                icon={SentIcon}
                className="size-4 shrink-0 text-general-blue-foreground"
            />
        </div>
    );
}

function ExchangeIcon() {
    return (
        <div
            className={cn(
                TYPE_ICON_CLASS,
                "border-general-pink-border bg-general-pink-background-faded",
            )}
        >
            <Icon
                icon={ArrowDataTransferHorizontalIcon}
                className="size-4 shrink-0 text-general-pink-foreground"
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
        case "Move to Confidential":
            return <TreasuryTypeIcon type="confidential" />;
        case "Function Call":
            return (
                <div
                    className={cn(
                        TYPE_ICON_CLASS,
                        "border-general-blue-border bg-general-blue-background-faded",
                    )}
                >
                    <Icon
                        icon={SourceCodeSquareIcon}
                        className="size-4 shrink-0 text-general-blue-foreground"
                    />
                </div>
            );
        case "Change Policy":
            return (
                <div
                    className={cn(
                        TYPE_ICON_CLASS,
                        "border-general-orange-border bg-general-orange-background-faded",
                    )}
                >
                    <Icon
                        icon={Shield01Icon}
                        className="size-4 shrink-0 text-general-orange-foreground"
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
                        icon={File01Icon}
                        className="shrink-0 dark:text-gray-400 text-gray-800"
                    />
                </div>
            );
    }
}
