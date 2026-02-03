import { InputBlock } from "./input-block";
import { Token } from "./token-input";

interface AmountSummaryProps {
    total: number | string;
    token: Token;
    title?: string;
    children?: React.ReactNode;
}

export function AmountSummary({
    total,
    token,
    title = "You are sending a total of",
    children,
}: AmountSummaryProps) {
    return (
        <InputBlock title="" invalid={false}>
            <div className="flex flex-col gap-2 p-2 text-xs text-muted-foreground text-center justify-center items-center">
                <p>{title}</p>
                <img
                    src={token.icon}
                    alt={token.symbol}
                    className="size-10 shrink-0 rounded-full"
                />
                <p className="text-xl font-semibold text-foreground">
                    {total} {token.symbol}
                </p>
                <div>{children}</div>
            </div>
        </InputBlock>
    );
}
