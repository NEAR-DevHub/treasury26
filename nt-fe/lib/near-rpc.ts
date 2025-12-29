/**
 * NEAR RPC Utilities
 * 
 * Helper functions to interact with NEAR blockchain via our backend proxy
 */

interface RPCRequest {
  jsonrpc: string;
  id: number | string;
  method: string;
  params: Record<string, any>;
}

interface RPCResponse<T = any> {
  jsonrpc: string;
  id: number | string;
  result?: T;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

/**
 * Generic function to call NEAR RPC methods through our backend proxy
 */
export async function callNearRPC<T = any>(
  method: string,
  params: Record<string, any>
): Promise<T> {
  const request: RPCRequest = {
    jsonrpc: "2.0",
    id: Date.now(),
    method,
    params,
  };

  const response = await fetch(
    `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api/near/rpc`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(request),
    }
  );

  if (!response.ok) {
    throw new Error(`RPC request failed: ${response.statusText}`);
  }

  const data: RPCResponse<T> = await response.json();

  if (data.error) {
    throw new Error(data.error.message || "RPC error");
  }

  if (!data.result) {
    throw new Error("No result in RPC response");
  }

  return data.result;
}

/**
 * Check if a NEAR account exists by viewing its account state
 */
export async function viewAccount(accountId: string): Promise<{
  amount: string;
  locked: string;
  code_hash: string;
  storage_usage: number;
  storage_paid_at: number;
  block_height: number;
  block_hash: string;
} | null> {
  try {
    const result = await callNearRPC("query", {
      request_type: "view_account",
      finality: "final",
      account_id: accountId,
    });
    return result;
  } catch (error) {
    // Account doesn't exist or other error
    return null;
  }
}

