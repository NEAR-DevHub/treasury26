import { http as axios } from "@/lib/http";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export interface PublicDashboardToken {
    rank: number;
    tokenId: string;
    symbol: string;
    name: string;
    icon: string | null;
    decimals: number;
    totalAmountRaw: string;
    totalUsd: string;
}

export interface PublicDashboardSnapshot {
    snapshotDate: string;
    daoCount: number;
    totalAumUsd: string;
    topTokens: PublicDashboardToken[];
}

export async function getPublicDashboardAum(): Promise<PublicDashboardSnapshot> {
    const response = await axios.get<PublicDashboardSnapshot>(
        `${BACKEND_API_BASE}/public/dashboard/aum`,
    );
    return response.data;
}
