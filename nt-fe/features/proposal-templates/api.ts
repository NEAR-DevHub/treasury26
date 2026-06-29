import axios, { isAxiosError } from "axios";
import type { ProposalTemplate } from "./types";

const BACKEND_API_BASE = `${process.env.NEXT_PUBLIC_BACKEND_API_BASE}/api`;

/** List a DAO's proposal templates (`GET /api/treasury/{dao_id}/proposal-templates`). */
export async function getProposalTemplates(
    daoId: string,
): Promise<ProposalTemplate[]> {
    const response = await axios.get<ProposalTemplate[]>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/proposal-templates`,
        { withCredentials: true },
    );
    return response.data;
}

/** Fields the create endpoint accepts; `manifest` is the raw authored JSON. */
export interface CreateProposalTemplateInput {
    name: string;
    description?: string | null;
    manifest: unknown;
    enabled?: boolean;
}

/**
 * Create a template (`POST /api/treasury/{dao_id}/proposal-templates`). Authoring is gated on the
 * DAO's `ChangePolicy` permission — a member who lacks it gets a 403, surfaced to the author.
 */
export async function createProposalTemplate(
    daoId: string,
    input: CreateProposalTemplateInput,
): Promise<ProposalTemplate> {
    const response = await axios.post<ProposalTemplate>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/proposal-templates`,
        input,
        { withCredentials: true },
    );
    return response.data;
}

/** Fields the update endpoint accepts; omitted fields are left unchanged (COALESCE on the server). */
export interface UpdateProposalTemplateInput {
    name?: string;
    description?: string | null;
    manifest?: unknown;
    enabled?: boolean;
    pinned?: boolean;
}

/**
 * Update a template (`PUT /api/treasury/{dao_id}/proposal-templates/{id}`). ChangePolicy-gated.
 * `id` is the template's UUID, not its slug.
 */
export async function updateProposalTemplate(
    daoId: string,
    id: string,
    input: UpdateProposalTemplateInput,
): Promise<ProposalTemplate> {
    const response = await axios.put<ProposalTemplate>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/proposal-templates/${id}`,
        input,
        { withCredentials: true },
    );
    return response.data;
}

/** Delete a template (`DELETE /api/treasury/{dao_id}/proposal-templates/{id}`). ChangePolicy-gated. */
export async function deleteProposalTemplate(
    daoId: string,
    id: string,
): Promise<void> {
    await axios.delete(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/proposal-templates/${id}`,
        { withCredentials: true },
    );
}

/**
 * Whether the Custom Requests feature is enabled for a treasury
 * (`GET /api/treasury/{dao_id}/custom-requests`). Membership-gated; defaults to false.
 */
export async function getCustomRequestsEnabled(
    daoId: string,
): Promise<boolean> {
    const response = await axios.get<{ enabled: boolean }>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/custom-requests`,
        { withCredentials: true },
    );
    return response.data.enabled;
}

/**
 * Enable or disable Custom Requests for a treasury
 * (`PUT /api/treasury/{dao_id}/custom-requests`). Gated on the DAO's `ChangePolicy` permission.
 */
export async function setCustomRequestsEnabled(
    daoId: string,
    enabled: boolean,
): Promise<boolean> {
    const response = await axios.put<{ enabled: boolean }>(
        `${BACKEND_API_BASE}/treasury/${encodeURIComponent(daoId)}/custom-requests`,
        { enabled },
        { withCredentials: true },
    );
    return response.data.enabled;
}

/** Extract the backend's plain-string error body (403/404/409) from an axios error, for toasts. */
export function apiErrorMessage(error: unknown, fallback: string): string {
    if (isAxiosError(error)) {
        const data = error.response?.data;
        if (typeof data === "string" && data.length > 0) {
            return data;
        }
    }
    return error instanceof Error ? error.message : fallback;
}
