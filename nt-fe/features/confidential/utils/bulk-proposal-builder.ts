import { encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import { V1_SIGNER_CONTRACT, V1_SIGNER_GAS } from "../constants";

interface ConfidentialBulkProposalParams {
    headerPayloadHash: string;
    recipientPayloadHashes: string[];
    treasuryId: string;
}

/**
 * Build a DAO proposal that signs the bulk-payment **header** intent hash via
 * v1.signer, and lists every recipient hash in the description.
 *
 * The header intent moves the full sum from the DAO's intents balance to the
 * per-DAO bulk-payment subaccount. The recipient hashes are signed later by
 * the subaccount on-chain (driven by the BE worker after the proposal is
 * approved).
 *
 * Description schema is the existing markdown format used by other
 * confidential proposals — opaque about amounts/tokens. The per-recipient
 * hashes go in a `payload_hashes: <csv>` line, which the BE relay matches
 * against `confidential_bulk_payments.header_payload_hash` to wire the rest
 * of the flow.
 */
export function buildConfidentialBulkProposal(
    params: ConfidentialBulkProposalParams,
) {
    const { headerPayloadHash, recipientPayloadHashes, treasuryId } = params;

    // Description is fully opaque. Notes are stored privately on the header
    // intent row (see nt-be bulk_payment_prepare.rs) and surfaced via
    // confidential_metadata only to authenticated DAO members.
    const description = encodeToMarkdown({
        proposal_action: "confidential",
        payload_hashes: recipientPayloadHashes.join(","),
        notes: "Confidential proposal. Details are hidden for privacy.",
    });

    return {
        proposal: {
            description,
            kind: {
                FunctionCall: {
                    receiver_id: V1_SIGNER_CONTRACT,
                    actions: [
                        {
                            method_name: "sign",
                            args: jsonToBase64({
                                request: {
                                    path: treasuryId,
                                    payload_v2: {
                                        Eddsa: headerPayloadHash,
                                    },
                                    domain_id: 1,
                                },
                            }),
                            deposit: "1",
                            gas: V1_SIGNER_GAS,
                        },
                    ],
                },
            },
        },
    };
}
