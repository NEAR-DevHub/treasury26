import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

// ============================================================================
// Auth API Types
// ============================================================================

export interface AuthChallengeResponse {
  nonce: string; // Base64 encoded
}

export interface LoginRequest {
  account_id: string;
  public_key: string;
  signature: string;
  message: string;
  nonce: string; // Base64 encoded
  recipient: string;
  callback_url?: string;
}

export interface LoginResponse {
  account_id: string;
  terms_accepted: boolean;
}

export interface AuthUserInfo {
  account_id: string;
  terms_accepted: boolean;
}

// ============================================================================
// Auth API Functions
// ============================================================================

/**
 * Request an authentication challenge (nonce) for the account
 * The nonce must be signed by the wallet to prove ownership
 */
export async function getAuthChallenge(
  accountId: string
): Promise<AuthChallengeResponse> {
  const response = await axios.post<AuthChallengeResponse>(
    `${BACKEND_API_BASE}/auth/challenge`,
    { account_id: accountId },
    { withCredentials: true }
  );
  return response.data;
}

/**
 * Login with a signed message
 * Verifies the signature and creates an auth session
 */
export async function authLogin(
  request: LoginRequest
): Promise<LoginResponse> {
  const response = await axios.post<LoginResponse>(
    `${BACKEND_API_BASE}/auth/login`,
    request,
    { withCredentials: true }
  );
  return response.data;
}

/**
 * Accept terms of service
 * Requires authentication
 */
export async function acceptTerms(): Promise<void> {
  await axios.post(
    `${BACKEND_API_BASE}/auth/accept-terms`,
    {},
    { withCredentials: true }
  );
}

/**
 * Get current authenticated user info
 * Returns null if not authenticated
 */
export async function getAuthMe(): Promise<AuthUserInfo | null> {
  try {
    const response = await axios.get<AuthUserInfo>(
      `${BACKEND_API_BASE}/auth/me`,
      { withCredentials: true }
    );
    return response.data;
  } catch (error) {
    // Not authenticated
    return null;
  }
}

/**
 * Logout - clears the auth session
 */
export async function authLogout(): Promise<void> {
  await axios.post(
    `${BACKEND_API_BASE}/auth/logout`,
    {},
    { withCredentials: true }
  );
}
