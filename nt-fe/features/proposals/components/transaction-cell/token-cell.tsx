import { useTranslations } from "next-intl";
import { Shield } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
    PaymentRequestData,
    VestingData,
    StakingData,
} from "../../types/index";
import { Amount } from "../amount";
import { TooltipUser } from "@/components/user";
import { TitleSubtitleCell } from "./title-subtitle-cell";
import { useProfile } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/hooks/use-treasury";
import { Tooltip } from "@/components/tooltip";
import { isNearComPaymentRoute } from "@/lib/intents-network";

interface TokenCellProps {
    data: PaymentRequestData | VestingData | StakingData;
    prefix?: string;
    isUser?: boolean;
    timestamp?: string;
    subtitleSuffix?: React.ReactNode;
    textOnly?: boolean;
}

function MiddleTruncatedText({ text }: { text: string }) {
    const ref = useRef<HTMLSpanElement>(null);
    const [displayText, setDisplayText] = useState(text);

    useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d");
        if (!context) return;

        const measure = () => {
            const width = element.clientWidth;
            if (!width) return;

            const styles = window.getComputedStyle(element);
            context.font = styles.font;

            if (context.measureText(text).width <= width) {
                setDisplayText(text);
                return;
            }

            const tailLength = Math.min(8, text.length);
            const tail = text.slice(-tailLength);
            const suffix = `...${tail}`;
            let low = 0;
            let high = text.length - tailLength;
            let nextText = suffix;

            while (low <= high) {
                const mid = Math.floor((low + high) / 2);
                const candidate = `${text.slice(0, mid)}${suffix}`;

                if (context.measureText(candidate).width <= width) {
                    nextText = candidate;
                    low = mid + 1;
                } else {
                    high = mid - 1;
                }
            }

            setDisplayText(nextText);
        };

        measure();

        const resizeObserver = new ResizeObserver(measure);
        resizeObserver.observe(element);

        return () => resizeObserver.disconnect();
    }, [text]);

    return (
        <span
            ref={ref}
            className="block min-w-0 max-w-full truncate"
            title={text}
        >
            {displayText}
        </span>
    );
}

export function TokenCell({
    data,
    prefix,
    isUser = true,
    timestamp,
    subtitleSuffix,
    textOnly = false,
}: TokenCellProps) {
    const t = useTranslations("proposals.expanded");
    const tCommon = useTranslations("common");
    const { isConfidential } = useTreasury();
    const effectivePrefix = prefix ?? t("toPrefix");
    const title = (
        <Amount
            amount={data.amount}
            tokenId={data.tokenId}
            showUSDValue={false}
            showNetworkTooltip
            expandNearComLabel={"destinationAssetId" in data}
            iconSize="sm"
            textOnly={textOnly}
        />
    );
    const { data: profile } = useProfile(data.receiver);
    const address = profile?.addressBookName ?? data.receiver;
    const destinationAssetId =
        "destinationAssetId" in data ? data.destinationAssetId : undefined;
    const showConfidentialAddressShield =
        isConfidential &&
        "destinationAssetId" in data &&
        isNearComPaymentRoute(data);

    const subtitle = data.receiver ? (
        <span className="inline-flex min-w-0 max-w-full flex-1 items-center overflow-hidden">
            <span className="shrink-0">{effectivePrefix}</span>
            {showConfidentialAddressShield && (
                <Tooltip content={tCommon("confidentialAddressTooltip")}>
                    <span className="inline-flex align-middle ml-1">
                        <Shield className="size-3.5 fill-foreground" />
                    </span>
                </Tooltip>
            )}
            {isUser ? (
                <TooltipUser
                    accountId={data.receiver}
                    useAddressBook
                    chainName={destinationAssetId}
                >
                    <span className="ml-1 inline-flex min-w-0 flex-1 overflow-hidden">
                        <MiddleTruncatedText text={address} />
                    </span>
                </TooltipUser>
            ) : (
                <span className="ml-1 min-w-0 truncate">{address}</span>
            )}
        </span>
    ) : undefined;

    return (
        <TitleSubtitleCell
            title={title}
            subtitle={subtitle}
            subtitleSuffix={subtitleSuffix}
            timestamp={timestamp}
        />
    );
}
