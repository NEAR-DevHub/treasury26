import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    approveMemberJoinRequests,
    cancelMemberJoinRequest,
    createMemberInvite,
    getMemberInvite,
    joinViaInvite,
    listMemberJoinRequests,
} from "@/lib/member-invites-api";

export function useMemberInvite(token: string | undefined) {
    return useQuery({
        queryKey: ["member-invite", token],
        queryFn: () => getMemberInvite(token!),
        enabled: !!token,
        retry: false,
    });
}

export function useCreateMemberInvite(daoId: string | undefined) {
    return useMutation({
        mutationFn: () => {
            if (!daoId) throw new Error("Missing treasury id");
            return createMemberInvite(daoId);
        },
    });
}

export function useJoinViaInvite() {
    return useMutation({
        mutationFn: ({
            token,
            displayName,
        }: {
            token: string;
            displayName?: string;
        }) => joinViaInvite(token, displayName),
    });
}

export function useMemberJoinRequests(daoId: string | undefined) {
    return useQuery({
        queryKey: ["member-join-requests", daoId],
        queryFn: () => listMemberJoinRequests(daoId!),
        enabled: !!daoId,
    });
}

export function useCancelMemberJoinRequest(daoId: string | undefined) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (requestId: string) => {
            if (!daoId) throw new Error("Missing treasury id");
            return cancelMemberJoinRequest(daoId, requestId);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["member-join-requests", daoId],
            });
        },
    });
}

export function useApproveMemberJoinRequests(daoId: string | undefined) {
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: (requestIds: string[]) => {
            if (!daoId) throw new Error("Missing treasury id");
            return approveMemberJoinRequests(daoId, requestIds);
        },
        onSuccess: () => {
            queryClient.invalidateQueries({
                queryKey: ["member-join-requests", daoId],
            });
        },
    });
}
