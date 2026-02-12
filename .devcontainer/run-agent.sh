#!/bin/bash
set -e

# Script to run Claude Code agent for implementing issue #159
# Usage: bash .devcontainer/run-agent.sh

cd /workspaces/treasury26

echo "=== Starting Claude Code Agent for Issue #159 ==="
echo ""
echo "Task: Distinguish swaps from payments using transaction grouping"
echo "See: https://github.com/NEAR-DevHub/treasury26/issues/159"
echo ""

# Ensure database is running
if ! docker compose -f nt-be/docker-compose.yml ps postgres_test | grep -q "running"; then
    echo "Starting database..."
    bash .devcontainer/post-start.sh
fi

# Run Claude Code with the implementation task
# Using --dangerously-skip-permissions for automated mode (agent has full access)
claude --dangerously-skip-permissions -p "
You are implementing GitHub issue #159: Distinguish swaps from payments using transaction grouping.

## Context
Read the issue at: https://github.com/NEAR-DevHub/treasury26/issues/159

The issue has been verified with real data. Key findings:
- Balance changes have receipt_id but transaction_hashes = '{}' (empty)
- Swap legs occur at different blocks (not same block)
- All swap-related receipts trace back to the same originating transaction
- Test account: webassemblymusic-treasury.sputnik-dao.near

## Your Tasks

1. **Read the full issue** using: gh issue view 159

2. **Implement Task 1**: Add resolve_receipt_to_transaction function
   - File: nt-be/src/handlers/balance_changes/transfer_hints/tx_resolver.rs
   - Walk receipt predecessor chain to find originating transaction
   - Use EXPERIMENTAL_receipt RPC

3. **Implement Task 2**: Add backfill function for transaction hashes
   - Update existing records that have receipt_id but empty transaction_hashes

4. **Implement Task 3**: Add swap detection logic
   - Create new file: nt-be/src/handlers/balance_changes/swap_detector.rs
   - Detect swaps by finding pairs of intents token changes with same tx_hash

5. **Write integration tests** with real historical data
   - File: nt-be/tests/swap_detection_test.rs
   - Use webassemblymusic-treasury.sputnik-dao.near account
   - Test the USDC → Base USDC swap (blocks 171108230-171108241)

6. **Run tests** to verify: cargo test

## Guidelines
- Follow TDD approach (tests first)
- Use real data, no mocks
- Read CLAUDE.md and .github/copilot-instructions.md for coding guidelines
- Commit changes with conventional commit messages

Start by reading the issue and exploring the existing code.
"
