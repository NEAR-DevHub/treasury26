import { http as axios } from "@/lib/http";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export interface ConnectedTreasury {
    daoId: string;
}

export interface ChatInfo {
    chatId: number;
    chatTitle: string | null;
    expiresAt: string;
    connectedTreasuries: ConnectedTreasury[];
}

export interface ConnectTreasuriesResponse {
    connected: boolean;
    chatId: number;
    treasuryIds: string[];
}

export interface TelegramStatus {
    daoId: string;
    connected: boolean;
    chatId: number | null;
    chatTitle: string | null;
}

export async function getTelegramChatInfo(token: string): Promise<ChatInfo> {
    const { data } = await axios.get<ChatInfo>(
        `${BACKEND_API_BASE}/telegram/connect`,
        { params: { token }, withCredentials: true },
    );
    return data;
}

export async function connectTreasuries(
    token: string,
    treasuryIds: string[],
): Promise<ConnectTreasuriesResponse> {
    const { data } = await axios.post<ConnectTreasuriesResponse>(
        `${BACKEND_API_BASE}/telegram/connect`,
        { token, treasuryIds },
        { withCredentials: true },
    );
    return data;
}

export async function disconnectTreasury(daoId: string): Promise<void> {
    await axios.delete(`${BACKEND_API_BASE}/telegram/connect`, {
        data: { daoId },
        withCredentials: true,
    });
}

export async function getTelegramStatus(
    daoId: string,
): Promise<TelegramStatus> {
    const { data } = await axios.get<TelegramStatus>(
        `${BACKEND_API_BASE}/telegram/status`,
        { params: { daoId }, withCredentials: true },
    );
    return data;
}
