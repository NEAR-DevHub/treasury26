import { cn } from "@/lib/utils";

/** Everything the pair needs from a token, whatever endpoint it came from. */
type PairToken = { symbol: string; icon?: string };

/** Token glyph sized for the overlapping swap pair, which needs 20/28px. */
function TokenGlyph({
    token,
    className,
}: {
    token: PairToken;
    className?: string;
}) {
    const icon = token.icon;
    const isImageIcon =
        !!icon && (icon.startsWith("data:image") || icon.startsWith("http"));

    return isImageIcon ? (
        <img
            src={icon}
            alt={token.symbol}
            className={cn("shrink-0 rounded-full", className)}
        />
    ) : (
        <div
            className={cn(
                "flex shrink-0 items-center justify-center rounded-full bg-brand-blue text-white text-xs font-normal",
                className,
            )}
        >
            {token.symbol.charAt(0).toUpperCase()}
        </div>
    );
}

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
                <TokenGlyph
                    token={sent}
                    className="absolute left-0 top-0 size-5"
                />
            )}
            {received && (
                <TokenGlyph
                    token={received}
                    className="absolute bottom-0 right-0 size-7 border border-card bg-card"
                />
            )}
        </div>
    );
}
