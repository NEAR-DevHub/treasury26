import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

export type InviteLinkStatus = "valid" | "used" | "expired" | "not_found";

export interface CreateInviteResponse {
    token: string;
    url: string;
}

export interface InviteLinkInfo {
    daoId: string;
    treasuryName?: string | null;
    status: InviteLinkStatus;
}

export interface JoinViaInviteResponse {
    daoId: string;
    requestId: string;
}

export interface MemberJoinRequest {
    id: string;
    accountId: string;
    displayName: string | null;
    createdAt: string;
}

export async function createMemberInvite(
    daoId: string,
): Promise<CreateInviteResponse> {
    const { data } = await axios.post<CreateInviteResponse>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/member-invites`,
        {},
        { withCredentials: true },
    );
    return data;
}

export async function getMemberInvite(token: string): Promise<InviteLinkInfo> {
    const { data } = await axios.get<InviteLinkInfo>(
        `${BACKEND_API_BASE}/member-invites/${encodeURIComponent(token)}`,
        { withCredentials: true },
    );
    return data;
}

export async function joinViaInvite(
    token: string,
    displayName?: string,
): Promise<JoinViaInviteResponse> {
    const { data } = await axios.post<JoinViaInviteResponse>(
        `${BACKEND_API_BASE}/member-invites/${encodeURIComponent(token)}/join`,
        { displayName: displayName?.trim() || undefined },
        { withCredentials: true },
    );
    return data;
}

export async function listMemberJoinRequests(
    daoId: string,
): Promise<MemberJoinRequest[]> {
    const { data } = await axios.get<MemberJoinRequest[]>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/member-join-requests`,
        { withCredentials: true },
    );
    return data;
}

export async function cancelMemberJoinRequest(
    daoId: string,
    requestId: string,
): Promise<void> {
    await axios.delete(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/member-join-requests/${encodeURIComponent(requestId)}`,
        { withCredentials: true },
    );
}

export async function approveMemberJoinRequests(
    daoId: string,
    requestIds: string[],
): Promise<void> {
    await axios.post(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/member-join-requests/approve`,
        { requestIds },
        { withCredentials: true },
    );
}
