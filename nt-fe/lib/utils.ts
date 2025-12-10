import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}


export function formatBalance(balance: string | bigint, decimals: number, displayDecimals: number = 2): string {

  let parsedBalance: bigint;
  if (typeof balance === "string") {
    parsedBalance = BigInt(balance);
  } else {
    parsedBalance = balance;
  }
  return (
    (Number(parsedBalance / BigInt(10) ** BigInt(decimals - displayDecimals)))
    / (10 ** displayDecimals)).toFixed(displayDecimals);
}
