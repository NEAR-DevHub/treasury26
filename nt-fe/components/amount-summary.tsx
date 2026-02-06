import Big from "big.js";
import { InputBlock } from "./input-block";
import { Token } from "./token-input";
import { formatCurrency } from "@/lib/utils";

interface AmountSummaryProps {
    total: Big | string;
    totalUSD?: number;
    token: Token;
    title?: string;
    children?: React.ReactNode;
}

export function AmountSummary({
    total,
    token,
    title = "You are sending a total of",
    totalUSD,
    children,
}: AmountSummaryProps) {
    return (
        <InputBlock title="" invalid={false}>
            <div className="flex flex-col gap-2 p-2 text-xs text-muted-foreground text-center justify-center items-center">
                <p className="font-medium text-xs">{title}</p>
                <img
                    src={token.icon}
                    alt={token.symbol}
                    className="size-9 shrink-0 rounded-full"
                />
                <div className="flex flex-col gap-0.5">
                    <p className="text-lg font-semibold text-foreground">
                        {total instanceof Big ? total.toString() : total}{" "}
                        <span className="text-muted-foreground font-medium text-xs">
                            {token.symbol}
                        </span>
                    </p>
                    {totalUSD && (
                        <p className="text-xxs text-muted-foreground">
                            ≈{formatCurrency(totalUSD)}
                        </p>
                    )}
                </div>
                <div>{children}</div>
            </div>
        </InputBlock>
    );
}
