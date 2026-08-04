import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
    approveMemberJoinRequests,
    cancelMemberJoinRequest,
    createMemberInvite,
    getMemberInvite,
    getMyMemberJoinStatus,
    joinViaInvite,
    listMemberJoinRequests,
} from "@/lib/member-invites-api";
import { useNear } from "@/stores/near-store";

export function useMemberInvite(token: string | undefined) {
    // Refetch after wallet connect so viewerStatus is resolved for the session.
    const { accountId } = useNear();
    return useQuery({
        queryKey: ["member-invite", token, accountId ?? null],
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
    const queryClient = useQueryClient();
    return useMutation({
        mutationFn: ({
            token,
            displayName,
        }: {
            token: string;
            displayName?: string;
        }) => joinViaInvite(token, displayName),
        onSuccess: (result) => {
            queryClient.invalidateQueries({
                queryKey: ["member-invite"],
            });
            queryClient.invalidateQueries({
                queryKey: ["my-member-join-status", result.daoId],
            });
        },
    });
}

export function useMyMemberJoinStatus(
    daoId: string | undefined,
    enabled = true,
) {
    return useQuery({
        queryKey: ["my-member-join-status", daoId],
        queryFn: () => getMyMemberJoinStatus(daoId!),
        enabled: !!daoId && enabled,
        retry: false,
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
