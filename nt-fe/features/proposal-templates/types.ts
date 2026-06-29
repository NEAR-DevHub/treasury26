/**
 * A stored proposal template as returned by the backend
 * (`GET /api/treasury/{dao_id}/proposal-templates`, serialized camelCase).
 *
 * `manifest` is the raw JSON the author saved — validate it with `parseManifest` before handing it
 * to the form (`buildFormSchema`) or the engine (`buildTemplateProposal`).
 */
export interface ProposalTemplate {
    id: string;
    daoId: string;
    name: string;
    description: string | null;
    manifest: unknown;
    enabled: boolean;
    pinned: boolean;
    createdBy: string | null;
    createdAt: string;
    updatedAt: string;
}
