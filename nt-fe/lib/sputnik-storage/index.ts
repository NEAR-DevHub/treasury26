/**
 * Sputnik-DAO storage estimator.
 *
 * Loads the sputnik-dao v2 WASM contract into a mock NEAR environment,
 * then simulates add_proposal / act_proposal calls to measure the exact
 * storage delta in bytes. This replaces hardcoded estimates with real numbers.
 *
 * Usage:
 *   const bytes = await estimateProposalStorage({ description: "...", kind: { Transfer: ... } });
 *   const cost = Big(bytes).mul(Big(10).pow(19)); // yoctoNEAR
 */

import { MockNearEnv } from "./mock-near-env";
import { prepareWASM } from "./prepare-wasm";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WasmExports = Record<string, (...args: any[]) => any>;

const COUNCIL_MEMBER = "council-member.near";
const SECOND_COUNCIL = "second-council.near";
const DAO_ACCOUNT = "test-dao.sputnik-dao.near";

// 0.1 NEAR proposal bond
const PROPOSAL_BOND = 100_000_000_000_000_000_000_000n;

// Minimal sputnik-dao v2 policy for initialization
const MINIMAL_POLICY = {
    roles: [
        {
            name: "council",
            kind: { Group: [COUNCIL_MEMBER, SECOND_COUNCIL] },
            permissions: [
                "*:AddProposal",
                "*:VoteApprove",
                "*:VoteReject",
                "*:VoteRemove",
            ],
            vote_policy: {},
        },
    ],
    default_vote_policy: {
        weight_kind: "RoleWeight",
        quorum: "0",
        threshold: [1, 2],
    },
    proposal_bond: PROPOSAL_BOND.toString(),
    proposal_period: "604800000000000",
    bounty_bond: PROPOSAL_BOND.toString(),
    bounty_forgiveness_period: "604800000000000",
};

let cachedInstance: {
    exports: WasmExports;
    nearenv: MockNearEnv;
    postInitSnapshot: Record<string, Uint8Array>;
} | null = null;

async function loadWasm(): Promise<Uint8Array> {
    if (typeof window !== "undefined") {
        // Browser: fetch from public directory
        const response = await fetch("/sputnik_dao_v2.wasm");
        const buffer = await response.arrayBuffer();
        return new Uint8Array(buffer);
    } else {
        // Node.js (SSR / scripts)
        const fs = await import("fs");
        const path = await import("path");
        const wasmPath = path.join(
            process.cwd(),
            "public",
            "sputnik_dao_v2.wasm",
        );
        return new Uint8Array(fs.readFileSync(wasmPath));
    }
}

async function getInstance() {
    if (cachedInstance) return cachedInstance;

    const wasmBinary = await loadWasm();
    const preparedBinary = prepareWASM(wasmBinary);

    const nearenv = new MockNearEnv();
    const memory = new WebAssembly.Memory({ initial: 1024, maximum: 2048 });
    nearenv.setWasmMemory(memory);

    const wasmModule = await WebAssembly.instantiate(preparedBinary, {
        env: { memory, ...nearenv.getImports() },
    });

    const exports = wasmModule.instance.exports as unknown as WasmExports;

    // Initialize the contract with minimal policy
    nearenv.setPredecessorAccountId(DAO_ACCOUNT);
    nearenv.setCurrentAccountId(DAO_ACCOUNT);
    nearenv.setSignerAccountId(DAO_ACCOUNT);
    nearenv.setArgs({
        config: {
            name: "Test DAO",
            purpose: "Storage estimation",
            metadata: "",
        },
        policy: MINIMAL_POLICY,
    });
    exports.new();

    // Snapshot the post-init storage state
    const postInitSnapshot = nearenv.snapshotStorage();

    cachedInstance = { exports, nearenv, postInitSnapshot };
    return cachedInstance;
}

/**
 * Estimate the storage cost in bytes for a given proposal.
 *
 * @param proposal - The proposal object (same shape as passed to add_proposal)
 *   e.g. { description: "Transfer 10 NEAR", kind: { Transfer: { receiver_id: "bob.near", token_id: "", amount: "10000000000000000000000000" } } }
 * @returns Storage delta in bytes
 */
export async function estimateProposalStorage(proposal: {
    description: string;
    kind: unknown;
}): Promise<number> {
    const { exports, nearenv, postInitSnapshot } = await getInstance();

    // Restore to clean post-init state
    nearenv.restoreStorage(postInitSnapshot);

    // Get storage before
    const storageBefore = nearenv.getImports().storage_usage() as bigint;

    // Call add_proposal as a council member
    nearenv.setPredecessorAccountId(COUNCIL_MEMBER);
    nearenv.setSignerAccountId(COUNCIL_MEMBER);
    nearenv.setAttachedDeposit(PROPOSAL_BOND);
    nearenv.setArgs({ proposal });

    exports.add_proposal();

    // Get storage after
    const storageAfter = nearenv.getImports().storage_usage() as bigint;

    return Number(storageAfter - storageBefore);
}

/**
 * Estimate the storage cost in bytes for voting on a proposal.
 *
 * Creates a proposal first, then votes on it to measure the vote's storage delta.
 *
 * @param proposal - Optional proposal to create for the vote test.
 *   Defaults to a simple Transfer proposal.
 * @param action - The vote action. Defaults to "VoteApprove".
 * @returns Storage delta in bytes
 */
export async function estimateVoteStorage(
    proposal?: { description: string; kind: unknown },
    action: string = "VoteApprove",
): Promise<number> {
    const { exports, nearenv, postInitSnapshot } = await getInstance();

    // Restore to clean post-init state
    nearenv.restoreStorage(postInitSnapshot);

    const defaultProposal = proposal ?? {
        description: "Test transfer",
        kind: {
            Transfer: {
                receiver_id: "bob.near",
                token_id: "",
                amount: "1000000000000000000000000",
            },
        },
    };

    // Create a proposal first
    nearenv.setPredecessorAccountId(COUNCIL_MEMBER);
    nearenv.setSignerAccountId(COUNCIL_MEMBER);
    nearenv.setAttachedDeposit(PROPOSAL_BOND);
    nearenv.setArgs({ proposal: defaultProposal });
    exports.add_proposal();

    // The proposal ID is returned as the last return value
    const proposalId = parseInt(nearenv.latestReturnValue, 10) || 0;

    // Measure storage before vote
    const storageBefore = nearenv.getImports().storage_usage() as bigint;

    // Vote as a different council member
    nearenv.setPredecessorAccountId(SECOND_COUNCIL);
    nearenv.setSignerAccountId(SECOND_COUNCIL);
    nearenv.setAttachedDeposit(0n);
    nearenv.setArgs({ id: proposalId, action });
    exports.act_proposal();

    // Measure storage after vote
    const storageAfter = nearenv.getImports().storage_usage() as bigint;

    return Number(storageAfter - storageBefore);
}

/**
 * Run a full estimation report for common proposal types and votes.
 * Useful for debugging/calibrating the hardcoded estimates.
 */
export async function runStorageReport(): Promise<Record<string, number>> {
    const results: Record<string, number> = {};

    // Transfer proposal (NEAR)
    results["proposal:Transfer(NEAR)"] = await estimateProposalStorage({
        description: "Transfer 10 NEAR to bob.near",
        kind: {
            Transfer: {
                receiver_id: "bob.near",
                token_id: "",
                amount: "10000000000000000000000000",
            },
        },
    });

    // Transfer proposal (FT)
    results["proposal:Transfer(FT)"] = await estimateProposalStorage({
        description: "Transfer 100 USDT",
        kind: {
            Transfer: {
                receiver_id: "bob.near",
                token_id: "usdt.tether-token.near",
                amount: "100000000",
            },
        },
    });

    // FunctionCall proposal
    results["proposal:FunctionCall"] = await estimateProposalStorage({
        description: "Call a contract method",
        kind: {
            FunctionCall: {
                receiver_id: "some-contract.near",
                actions: [
                    {
                        method_name: "do_something",
                        args: btoa(JSON.stringify({ key: "value" })),
                        deposit: "0",
                        gas: "30000000000000",
                    },
                ],
            },
        },
    });

    // AddMemberToRole proposal
    results["proposal:AddMemberToRole"] = await estimateProposalStorage({
        description: "Add new council member",
        kind: {
            AddMemberToRole: {
                member_id: "new-member.near",
                role: "council",
            },
        },
    });

    // RemoveMemberFromRole proposal
    results["proposal:RemoveMemberFromRole"] = await estimateProposalStorage({
        description: "Remove council member",
        kind: {
            RemoveMemberFromRole: {
                member_id: "old-member.near",
                role: "council",
            },
        },
    });

    // ChangePolicyAddOrUpdateRole proposal
    results["proposal:ChangePolicy"] = await estimateProposalStorage({
        description: "Update policy",
        kind: {
            ChangePolicy: { policy: MINIMAL_POLICY },
        },
    });

    // Vote
    results["vote:VoteApprove"] = await estimateVoteStorage();

    return results;
}
