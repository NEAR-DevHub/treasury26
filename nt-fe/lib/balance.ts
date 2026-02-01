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

export interface StakingPoolAccountInfo {
    poolId: string;
    stakedBalance: Big;
    unstakedBalance: Big;
    canWithdraw: boolean;
}

export interface StakingBalance {
    stakedBalance: Big;
    unstakedBalance: Big;
    canWithdraw: boolean;
    pools: StakingPoolAccountInfo[];
}

export type Balance =
    | { type: "Standard"; total: Big; locked: Big }
    | { type: "Staked"; staking: StakingBalance }
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

interface StakingPoolAccountInfoRaw {
    poolId: string;
    stakedBalance: string;
    unstakedBalance: string;
    canWithdraw: boolean;
}

interface StakingBalanceRaw {
    stakedBalance: string;
    unstakedBalance: string;
    canWithdraw: boolean;
    pools: StakingPoolAccountInfoRaw[];
}

export type BalanceRaw =
    | { Standard: { total: string; locked: string } }
    | { Staked: StakingBalanceRaw }
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
    } else if ("Staked" in raw) {
        const staking: StakingBalance = {
            stakedBalance: Big(raw.Staked.stakedBalance),
            unstakedBalance: Big(raw.Staked.unstakedBalance),
            canWithdraw: raw.Staked.canWithdraw,
            pools: raw.Staked.pools.map((pool) => ({
                poolId: pool.poolId,
                stakedBalance: Big(pool.stakedBalance),
                unstakedBalance: Big(pool.unstakedBalance),
                canWithdraw: pool.canWithdraw,
            })),
        };
        const total = staking.stakedBalance.add(staking.unstakedBalance);
        return {
            balance: { type: "Staked", staking },
            total,
        };
    } else {
        // Fallback for unknown types
        return {
            balance: { type: "Standard", total: Big(0), locked: Big(0) },
            total: Big(0),
        };
    }
}

export function totalBalance(balance: Balance): Big {
    if (balance.type === "Standard") {
        return balance.total;
    } else if (balance.type === "Staked") {
        return balance.staking.stakedBalance.add(balance.staking.unstakedBalance);
    } else if (balance.type === "Vested") {
        return balance.lockup.total;
    }
    return Big(0);
}

export function availableBalance(balance: Balance): Big {
    if (balance.type === "Standard") {
        return balance.total.sub(balance.locked);
    } else if (balance.type === "Staked") {
        // Available for withdraw if canWithdraw is true
        return balance.staking.canWithdraw ? balance.staking.unstakedBalance : Big(0);
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
        // Staked balance + pending unstaked (not yet withdrawable)
        const pendingUnstaked = balance.staking.canWithdraw ? Big(0) : balance.staking.unstakedBalance;
        return balance.staking.stakedBalance.add(pendingUnstaked);
    } else if (balance.type === "Vested") {
        const largestLockup = balance.lockup.unvested.gt(balance.lockup.staked) ? balance.lockup.unvested : balance.lockup.staked;
        return largestLockup.add(balance.lockup.storageLocked);
    }
    return Big(0);
}
