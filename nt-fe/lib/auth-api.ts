import axios from "axios";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

// ============================================================================
// Auth API Types
// ============================================================================

export interface AuthChallengeResponse {
    nonce: string; // Base64 encoded
}

export interface LoginRequest {
    accountId: string;
    publicKey: string;
    signature: string;
    message: string;
    nonce: string; // Base64 encoded
    recipient: string;
    callbackUrl?: string;
}

export interface LoginResponse {
    accountId: string;
    termsAccepted: boolean;
}

export interface AuthUserInfo {
    accountId: string;
    termsAccepted: boolean;
}

// ============================================================================
// Auth API Functions
// ============================================================================

/**
 * Request an authentication challenge (nonce).
 */
export async function getAuthChallenge(): Promise<AuthChallengeResponse> {
    const response = await axios.post<AuthChallengeResponse>(
        `${BACKEND_API_BASE}/auth/challenge`,
        {},
        { withCredentials: true },
    );
    return response.data;
}

/**
 * Login with a signed message
 * Verifies the signature and creates an auth session
 */
export async function authLogin(request: LoginRequest): Promise<LoginResponse> {
    const response = await axios.post<LoginResponse>(
        `${BACKEND_API_BASE}/auth/login`,
        request,
        { withCredentials: true },
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
        { withCredentials: true },
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
            { withCredentials: true },
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
        { withCredentials: true },
    );
}
