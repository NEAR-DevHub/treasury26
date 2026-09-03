import { TokenIconImage } from "./token-icon-image";

/** Everything the pair needs from a token, whatever endpoint it came from. */
type PairToken = { symbol: string; icon?: string };

/** Sent token tucked behind the received one, matching the 36px row badge. */
export function SwapTokenPair({
    sent,
    received,
}: {
    sent?: PairToken | null;
    received?: PairToken | null;
}) {
    return (
        <div className="relative size-9 shrink-0">
            {sent && (
                <TokenIconImage
                    icon={sent.icon}
                    alt={sent.symbol}
                    className="absolute left-0 top-0 size-5"
                />
            )}
            {received && (
                <TokenIconImage
                    icon={received.icon}
                    alt={received.symbol}
                    className="absolute bottom-0 right-0 size-7 border border-card bg-card"
                />
            )}
        </div>
    );
}
