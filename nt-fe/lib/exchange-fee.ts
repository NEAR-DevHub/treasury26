import Big from "@/lib/big";

export const EXCHANGE_FEE_PERCENTAGE = 0.7;

export function calculateExchangeFeeAmount(amount: string | number) {
    return Big(amount).mul(EXCHANGE_FEE_PERCENTAGE).div(100);
}
