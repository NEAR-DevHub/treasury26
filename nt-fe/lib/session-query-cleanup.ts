import type { QueryClient } from "@tanstack/react-query";

export async function clearSessionQueries(queryClient: QueryClient) {
    await queryClient.cancelQueries();
    queryClient.removeQueries();
}
