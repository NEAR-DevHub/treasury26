import { Big } from "big.js";
import { formatNearAmount } from "./utils";

export interface LockupBalance {
    total: Big;
    totalAllocated: Big;
    unvested: Big;
    staked: Big;
    storageLocked: Big;
    unstakedBalance: Big;
    canWithdraw: boolean;
}

export type Balance =
    | { type: "Standard"; total: Big; locked: Big }
    | { type: "Staked" }
    | { type: "Vested"; lockup: LockupBalance };


interface LockupBalanceRaw {
    total: string;
    totalAllocated: string;
    storageLocked: string;
    unvested: string;
    staked: string;
    unstakedBalance: string;
    canWithdraw: boolean;
}

export type BalanceRaw =
    | { Standard: { total: string; locked: string } }
    | { Staked: [] }
    | { Vested: LockupBalanceRaw };

export function transformBalance(raw: BalanceRaw): { balance: Balance; total: Big } {
    if ("Standard" in raw) {
        const total = Big(raw.Standard.total);
        const locked = Big(raw.Standard.locked);
        return {
            balance: { type: "Standard", total, locked },
            total,
        };
    } else if ("Vested" in raw) {
        const lockup: LockupBalance = {
            total: Big(raw.Vested.total),
            totalAllocated: Big(raw.Vested.totalAllocated),
            storageLocked: Big(raw.Vested.storageLocked),
            unvested: Big(raw.Vested.unvested),
            staked: Big(raw.Vested.staked),
            unstakedBalance: Big(raw.Vested.unstakedBalance),
            canWithdraw: raw.Vested.canWithdraw,
        };
        return {
            balance: { type: "Vested", lockup },
            total: lockup.total,
        };
    } else {
        return {
            balance: { type: "Staked" },
            total: Big(0),
        };
    }
};

export function totalBalance(balance: Balance): Big {
    if (balance.type === "Standard") {
        return balance.total;
    } else if (balance.type === "Staked") {
        return Big(0);
    } else if (balance.type === "Vested") {
        return balance.lockup.total;
    }
    return Big(0);
}

export function availableBalance(balance: Balance): Big {
    if (balance.type === "Standard") {
        return balance.total.sub(balance.locked);
    } else if (balance.type === "Staked") {
        return Big(0);
    } else if (balance.type === "Vested") {
        const restriction = balance.lockup.unvested.lt(balance.lockup.staked) ? balance.lockup.staked : balance.lockup.unvested;
        const available = balance.lockup.total
            .sub(restriction)
            .sub(balance.lockup.storageLocked);
        return available.gt(Big(0)) ? available : Big(0);
    }
    return Big(0);
}

export function lockedBalance(balance: Balance): Big {
    if (balance.type === "Standard") {
        return balance.locked;
    } else if (balance.type === "Staked") {
        return Big(0);
    } else if (balance.type === "Vested") {
        const largestLockup = balance.lockup.unvested.gt(balance.lockup.staked) ? balance.lockup.unvested : balance.lockup.staked;
        return largestLockup.add(balance.lockup.storageLocked);
    }
    return Big(0);
}
