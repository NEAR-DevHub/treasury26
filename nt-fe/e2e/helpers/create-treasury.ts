/**
 * Helper to create a treasury via the SSE create-stream endpoint.
 *
 * Used by E2E tests that need a DAO registered in the sandbox backend.
 */

import { loginAndGetCookie } from "./auth";

const BACKEND_URL =
    process.env.BACKEND_URL ||
    process.env.NEXT_PUBLIC_BACKEND_API_BASE ||
    "http://localhost:8080";

interface TreasuryConfigResponse {
    name?: string;
}

export interface CreateTreasuryOptions {
    name: string;
    accountId: string;
    paymentThreshold?: number;
    governanceThreshold?: number;
    governors: string[];
    financiers: string[];
    requestors: string[];
    isConfidential?: boolean;
}

async function treasuryExists(accountId: string): Promise<boolean> {
    const resp = await fetch(
        `${BACKEND_URL}/api/treasury/config?treasuryId=${accountId}`,
    );

    if (resp.status === 404) {
        return false;
    }

    if (!resp.ok) {
        const message = await resp.text();
        // Sandbox returns 500 UnknownAccount for missing DAOs.
        if (message.includes("UnknownAccount")) {
            return false;
        }
        throw new Error(
            `Failed to check DAO config: ${resp.status} ${message}`,
        );
    }

    const config = (await resp.json()) as TreasuryConfigResponse;
    return Boolean(config?.name);
}

function isAccountAlreadyExistsError(error: unknown): boolean {
    return String(error).includes("AccountAlreadyExists");
}

function isTransientRpcError(error: unknown): boolean {
    const message = String(error);
    return (
        message.includes("TransportError") ||
        message.includes("Communication Error") ||
        message.includes("localhost:3031")
    );
}

/**
 * Creates a treasury on the sandbox backend via the SSE stream endpoint.
 * Consumes the full stream and throws on error events.
 */
export async function createTreasury(
    opts: CreateTreasuryOptions,
): Promise<void> {
    // create-stream requires an authenticated member. Log in as one of the new
    // DAO's members (all sandbox accounts share the genesis key) and pass the
    // resulting session cookie.
    const member =
        opts.requestors[0] ?? opts.governors[0] ?? opts.financiers[0];
    if (!member) {
        throw new Error("createTreasury requires at least one member");
    }
    const cookie = await loginAndGetCookie(BACKEND_URL, member);

    const resp = await fetch(`${BACKEND_URL}/api/treasury/create-stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
            name: opts.name,
            accountId: opts.accountId,
            paymentThreshold: opts.paymentThreshold ?? 1,
            governanceThreshold: opts.governanceThreshold ?? 1,
            governors: opts.governors,
            financiers: opts.financiers,
            requestors: opts.requestors,
            isConfidential: opts.isConfidential ?? false,
        }),
    });

    if (!resp.ok) {
        throw new Error(
            `Failed to create DAO: ${resp.status} ${await resp.text()}`,
        );
    }

    // Consume SSE stream until "done" or "error"
    const reader = resp.body!.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop()!;
        for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const data = JSON.parse(line.slice(5).trim());
            console.log(`[CREATE] ${data.step}: ${data.status}`);
            if (data.step === "error") {
                throw new Error(`DAO creation failed: ${data.message}`);
            }
        }
    }
}

/**
 * Ensures a treasury exists once and can be safely reused across tests.
 * If it already exists, no-op; if creation races with another worker, treat
 * AccountAlreadyExists as success.
 */
export async function ensureTreasury(
    opts: CreateTreasuryOptions,
): Promise<void> {
    for (let attempt = 0; attempt < 10; attempt++) {
        try {
            if (await treasuryExists(opts.accountId)) {
                return;
            }

            await createTreasury(opts);
            return;
        } catch (error) {
            if (isAccountAlreadyExistsError(error)) {
                return;
            }
            if (!isTransientRpcError(error) || attempt === 9) {
                throw error;
            }
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }
    }

    throw new Error(`Failed to ensure DAO ${opts.accountId}`);
}
