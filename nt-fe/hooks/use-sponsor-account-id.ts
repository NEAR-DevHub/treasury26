import { useQuery } from "@tanstack/react-query";
import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

/**
 * Backend `SIGNER_ID` — the NEAR account that submits confidential-setup
 * proposals (add key, auth, ChangePolicy, etc.). Used to ignore those when
 * deciding whether a treasury has ever had "real" user requests.
 */
export function useSponsorAccountId() {
    return useQuery({
        queryKey: ["backend-signer-id"],
        queryFn: async (): Promise<string | null> => {
            const { data } = await axios.get<{ signer_id?: string }>(
                `${BACKEND_API_BASE}/health`,
                { timeout: 10_000 },
            );
            return data.signer_id ?? null;
        },
        staleTime: Infinity,
        retry: 1,
    });
}
