import axios from "axios";
import { useQuery } from "@tanstack/react-query";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export interface ChainInfo {
    key: string;
    name: string;
    icon: string;
}

export async function getChains(): Promise<ChainInfo[]> {
    const response = await axios.get<ChainInfo[]>(
        `${BACKEND_API_BASE}/chains`,
        {
            withCredentials: true,
        },
    );
    return response.data;
}

export function useChains() {
    return useQuery({
        queryKey: ["chains"],
        queryFn: getChains,
        staleTime: 1000 * 60 * 60, // 1 hour — chains don't change often
    });
}
