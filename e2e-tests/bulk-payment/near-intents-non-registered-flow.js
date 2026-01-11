/**
 * End-to-End Test: NEAR Intents Token Payments to Non-Registered Accounts
 *
 * This test demonstrates the behavior when making bulk payments with NEAR Intents tokens
 * (wrap.near on intents.near) to accounts that are not registered with the token contract.
 *
 * Test Scenario:
 * 1. Use existing DAO from dao-bulk-payment-flow.js (testdao.sputnik-dao.near)
 * 2. Create a payment list with nep141:wrap.near tokens (NEAR Intents format)
 * 3. Mix of registered and non-registered recipients:
 *    - Some implicit accounts will be registered with intents.near before payment
 *    - Some implicit accounts will NOT be registered (non-registered)
 * 4. Submit and approve the payment list
 * 5. Process payments
 * 6. Verify ALL payments are marked as processed (have block_height)
 * 7. Verify registered accounts show balance changes and successful transactions
 * 8. Verify non-registered accounts show failed receipts but still have block_height
 *
 * Configuration:
 * - SANDBOX_RPC_URL: URL of the NEAR sandbox RPC (default: http://localhost:3030)
 * - API_URL: URL of the bulk payment API (default: http://localhost:8080)
 * - BULK_PAYMENT_CONTRACT_ID: Bulk payment contract account
 *
 * Prerequisites:
 * - dao-bulk-payment-flow.js must have been run first to create the DAO
 * - intents.near contract must be deployed in the sandbox
 * - wrap.near contract must be deployed in the sandbox
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nearAPI from "near-api-js";
const { connect, keyStores, KeyPair, utils } = nearAPI;

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  // URLs - configurable via environment variables
  SANDBOX_RPC_URL: process.env.SANDBOX_RPC_URL || "http://localhost:3030",
  API_URL: process.env.API_URL || "http://localhost:8080",

  // Contract IDs
  DAO_FACTORY_ID: process.env.DAO_FACTORY_ID || "sputnik-dao.near",
  DAO_ACCOUNT_ID: process.env.DAO_ACCOUNT_ID || "testdao.sputnik-dao.near",
  BULK_PAYMENT_CONTRACT_ID:
    process.env.BULK_PAYMENT_CONTRACT_ID || "bulk-payment.near",
  INTENTS_CONTRACT_ID: process.env.INTENTS_CONTRACT_ID || "intents.near",
  WRAP_TOKEN_ID: process.env.WRAP_TOKEN_ID || "wrap.near",

  // Test parameters
  NUM_REGISTERED: parseInt(process.env.NUM_REGISTERED || "3", 10),
  NUM_NON_REGISTERED: parseInt(process.env.NUM_NON_REGISTERED || "3", 10),
  PAYMENT_AMOUNT: process.env.PAYMENT_AMOUNT || "1000000000000000000000000", // 1 wNEAR

  // Genesis account credentials (sandbox test key)
  GENESIS_ACCOUNT_ID: process.env.GENESIS_ACCOUNT_ID || "test.near",
  GENESIS_PRIVATE_KEY:
    process.env.GENESIS_PRIVATE_KEY ||
    "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
};

// Storage cost calculation constants
const BYTES_PER_RECORD = 216n;
const STORAGE_COST_PER_BYTE = 10n ** 19n;
const STORAGE_MARKUP_PERCENT = 110n;

// ============================================================================
// Utilities
// ============================================================================

function parseNEAR(amount) {
  return utils.format.parseNearAmount(amount.toString());
}

function formatNEAR(yoctoNear) {
  return utils.format.formatNearAmount(yoctoNear, 4);
}

function generateImplicitAccountId(index) {
  // Use modulo to ensure index fits in 8 hex digits (max 0xFFFFFFFF = 4,294,967,295)
  // This prevents overflow when using large timestamps
  const idx = index % 0x100000000;
  const hex = idx.toString(16).padStart(8, "0");
  return hex.repeat(8); // 64 characters
}

function generateListId(submitterId, tokenId, payments) {
  const sortedPayments = [...payments].sort((a, b) =>
    a.recipient.localeCompare(b.recipient)
  );
  const canonical = JSON.stringify({
    payments: sortedPayments.map((p) => ({
      amount: p.amount,
      recipient: p.recipient,
    })),
    submitter: submitterId,
    token_id: tokenId,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function apiRequest(
  endpoint,
  method = "GET",
  body = null,
  expectError = false
) {
  const url = `${CONFIG.API_URL}${endpoint}`;
  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
    },
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok && !expectError) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `API request failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }

  return response.json();
}

function calculateStorageCost(numRecords) {
  const storageBytes = BYTES_PER_RECORD * BigInt(numRecords);
  const storageCost = storageBytes * STORAGE_COST_PER_BYTE;
  const totalCost = (storageCost * STORAGE_MARKUP_PERCENT) / 100n;
  return totalCost.toString();
}

async function viewPaymentList(account, listId) {
  const list = await account.viewFunction({
    contractId: CONFIG.BULK_PAYMENT_CONTRACT_ID,
    methodName: "view_list",
    args: { list_id: listId },
  });
  return list;
}

// ============================================================================
// NEAR Connection Setup
// ============================================================================

async function setupNearConnection() {
  const keyStore = new keyStores.InMemoryKeyStore();

  const keyPair = KeyPair.fromString(CONFIG.GENESIS_PRIVATE_KEY);
  await keyStore.setKey("sandbox", CONFIG.GENESIS_ACCOUNT_ID, keyPair);

  const connectionConfig = {
    networkId: "sandbox",
    keyStore,
    nodeUrl: CONFIG.SANDBOX_RPC_URL,
  };

  const near = await connect(connectionConfig);
  const genesisAccount = await near.account(CONFIG.GENESIS_ACCOUNT_ID);

  return { near, genesisAccount, keyStore };
}

// ============================================================================
// DAO Operations
// ============================================================================

/**
 * Create a Sputnik DAO instance
 */
async function createDAO(account, daoName, creatorAccountId) {
  console.log(`\n📋 Creating DAO: ${daoName}.${CONFIG.DAO_FACTORY_ID}`);

  const daoAccountId = `${daoName}.${CONFIG.DAO_FACTORY_ID}`;

  const createDaoArgs = {
    name: daoName,
    args: Buffer.from(
      JSON.stringify({
        config: {
          name: daoName,
          purpose: "Testing bulk payments",
          metadata: "",
        },
        policy: {
          roles: [
            {
              kind: { Group: [creatorAccountId] },
              name: "council",
              permissions: ["*:*"],
              vote_policy: {},
            },
          ],
          default_vote_policy: {
            weight_kind: "RoleWeight",
            quorum: "0",
            threshold: [1, 2],
          },
          proposal_bond: "100000000000000000000000", // 0.1 NEAR
          proposal_period: "604800000000000", // 1 week in nanoseconds
          bounty_bond: "100000000000000000000000",
          bounty_forgiveness_period: "604800000000000",
        },
      })
    ).toString("base64"),
  };

  try {
    await account.functionCall({
      contractId: CONFIG.DAO_FACTORY_ID,
      methodName: "create",
      args: createDaoArgs,
      gas: "300000000000000", // 300 TGas
      attachedDeposit: parseNEAR("100"), // 100 NEAR for DAO creation (needs funds for proposals)
    });

    console.log(`✅ DAO created: ${daoAccountId}`);
  } catch (error) {
    if (error.message && error.message.includes("already exists")) {
      console.log(`ℹ️  DAO already exists: ${daoAccountId} (reusing)`);
    } else {
      throw error;
    }
  }

  return daoAccountId;
}

/**
 * Create a function call proposal in the DAO
 */
async function createProposal(
  account,
  daoAccountId,
  description,
  receiverId,
  methodName,
  args,
  deposit,
  gas
) {
  console.log(`\n📝 Creating proposal: ${description}`);

  const proposalArgs = {
    proposal: {
      description,
      kind: {
        FunctionCall: {
          receiver_id: receiverId,
          actions: [
            {
              method_name: methodName,
              args: Buffer.from(JSON.stringify(args)).toString("base64"),
              deposit: deposit || "0",
              gas: gas || "150000000000000", // Default: 150 TGas
            },
          ],
        },
      },
    },
  };

  const result = await account.functionCall({
    contractId: daoAccountId,
    methodName: "add_proposal",
    args: proposalArgs,
    gas: "300000000000000",
    attachedDeposit: parseNEAR("0.1"), // Proposal bond
  });

  const proposalId = await getLastProposalId(account, daoAccountId);
  console.log(`✅ Proposal created with ID: ${proposalId}`);
  return proposalId;
}

/**
 * Get the last proposal ID from the DAO
 */
async function getLastProposalId(account, daoAccountId) {
  const result = await account.viewFunction({
    contractId: daoAccountId,
    methodName: "get_last_proposal_id",
    args: {},
  });
  return result - 1; // get_last_proposal_id returns the next ID, so subtract 1
}

/**
 * Vote to approve a proposal
 */
async function approveProposal(account, daoAccountId, proposalId) {
  console.log(`\n✅ Approving proposal ${proposalId}`);

  await account.functionCall({
    contractId: daoAccountId,
    methodName: "act_proposal",
    args: {
      id: proposalId,
      action: "VoteApprove",
    },
    gas: "300000000000000",
  });

  console.log(`✅ Proposal ${proposalId} approved`);
}

/**
 * Get proposal status
 */
async function getProposalStatus(account, daoAccountId, proposalId) {
  const proposal = await account.viewFunction({
    contractId: daoAccountId,
    methodName: "get_proposal",
    args: { id: proposalId },
  });
  return proposal.status;
}

// ============================================================================
// Multi-Token (NEAR Intents) Operations
// ============================================================================

/**
 * Register an account with wrap.near token contract (NEP-141)
 * Note: intents.near doesn't have mt_storage_deposit - registration happens on the underlying token
 */
async function registerWithWrapNear(account, accountToRegister) {
  console.log(
    `📝 Registering ${accountToRegister} with ${CONFIG.WRAP_TOKEN_ID}...`
  );

  try {
    await account.functionCall({
      contractId: CONFIG.WRAP_TOKEN_ID,
      methodName: "storage_deposit",
      args: {
        account_id: accountToRegister,
        registration_only: true,
      },
      gas: "30000000000000", // 30 TGas
      attachedDeposit: parseNEAR("0.00125"), // Standard NEP-141 storage deposit
    });
    console.log(`✅ Registered ${accountToRegister}`);
    return true;
  } catch (error) {
    if (error.message && error.message.includes("already registered")) {
      console.log(`ℹ️  ${accountToRegister} already registered`);
      return true;
    }
    throw error;
  }
}

/**
 * Get multi-token balance for an account
 */
async function getMultiTokenBalance(account, accountId, tokenId) {
  try {
    const balance = await account.viewFunction({
      contractId: CONFIG.INTENTS_CONTRACT_ID,
      methodName: "mt_balance_of",
      args: {
        account_id: accountId,
        token_id: tokenId,
      },
    });
    return balance;
  } catch (error) {
    return "0";
  }
}

/**
 * Get wrap.near (NEP-141) token balance for an account
 * After ft_withdraw from intents.near, tokens go to wrap.near
 */
async function getWrapNearBalance(account, accountId) {
  try {
    const balance = await account.viewFunction({
      contractId: CONFIG.WRAP_TOKEN_ID,
      methodName: "ft_balance_of",
      args: { account_id: accountId },
    });
    return balance;
  } catch (error) {
    return "0";
  }
}

/**
 * Deposit wNEAR tokens into intents.near for an account
 * This uses ft_transfer_call on wrap.near to deposit tokens into intents.near
 */
async function depositToIntents(account, fromAccountId, amount) {
  console.log(`💸 Depositing ${amount} wNEAR tokens to intents.near...`);

  await account.functionCall({
    contractId: CONFIG.WRAP_TOKEN_ID,
    methodName: "ft_transfer_call",
    args: {
      receiver_id: CONFIG.INTENTS_CONTRACT_ID,
      amount: amount,
      msg: "", // Empty message for simple deposit
    },
    gas: "100000000000000", // 100 TGas for cross-contract call
    attachedDeposit: "1", // 1 yoctoNEAR for security
  });

  console.log(`✅ Deposited ${amount} wNEAR tokens to intents.near`);
}

// ============================================================================
// Main Test Flow
// ============================================================================

try {
  console.log("🚀 Starting NEAR Intents Non-Registered Account E2E Test");
  console.log("========================================================");
  console.log(`Sandbox RPC: ${CONFIG.SANDBOX_RPC_URL}`);
  console.log(`API URL: ${CONFIG.API_URL}`);
  console.log(`DAO Account: ${CONFIG.DAO_ACCOUNT_ID}`);
  console.log(`Bulk Payment Contract: ${CONFIG.BULK_PAYMENT_CONTRACT_ID}`);
  console.log(`Intents Contract: ${CONFIG.INTENTS_CONTRACT_ID}`);
  console.log(`Token: nep141:${CONFIG.WRAP_TOKEN_ID}`);
  console.log(`Registered Recipients: ${CONFIG.NUM_REGISTERED}`);
  console.log(`Non-Registered Recipients: ${CONFIG.NUM_NON_REGISTERED}`);
  console.log("========================================================\n");

  // Step 1: Setup NEAR connection
  console.log("📡 Connecting to NEAR sandbox...");
  const { near, genesisAccount, keyStore } = await setupNearConnection();
  console.log(`✅ Connected as genesis: ${genesisAccount.accountId}`);

  // Step 1.5: Create DAO (or reuse if it already exists)
  const daoName = "testdao";
  const daoAccountId = await createDAO(
    genesisAccount,
    daoName,
    genesisAccount.accountId
  );
  console.log(`✅ Using DAO: ${daoAccountId}`);

  // Step 2: Check API health
  console.log("\n🏥 Checking API health...");
  const health = await apiRequest("/health");
  assert.equal(health.status, "healthy", "API must be healthy");
  console.log(`✅ API is healthy`);

  // Step 3: Generate recipient accounts
  console.log(
    `\n👥 Generating ${CONFIG.NUM_REGISTERED + CONFIG.NUM_NON_REGISTERED} recipient accounts...`
  );
  const registeredRecipients = [];
  const nonRegisteredRecipients = [];

  // Use timestamp with offset to avoid collisions with other tests
  // Offset: 10000000 to distinguish from fungible-token test (1000000) and dao test (0)
  const startIndex = Date.now() + 10000000;

  // Generate registered recipients
  for (let i = 0; i < CONFIG.NUM_REGISTERED; i++) {
    const recipient = generateImplicitAccountId(startIndex + i);
    registeredRecipients.push(recipient);
  }

  // Generate non-registered recipients
  for (let i = 0; i < CONFIG.NUM_NON_REGISTERED; i++) {
    const recipient = generateImplicitAccountId(
      startIndex + CONFIG.NUM_REGISTERED + i
    );
    nonRegisteredRecipients.push(recipient);
  }

  console.log(`✅ Generated ${registeredRecipients.length} registered recipients`);
  console.log(
    `✅ Generated ${nonRegisteredRecipients.length} non-registered recipients`
  );

  // Step 4: Register some accounts with wrap.near (the underlying token)
  // Note: intents.near doesn't have mt_storage_deposit, registration is on the token contract
  console.log("\n📝 Registering accounts with wrap.near...");
  for (const recipient of registeredRecipients) {
    await registerWithWrapNear(genesisAccount, recipient);
    await sleep(500); // Small delay between registrations
  }
  console.log(
    `✅ Registered ${registeredRecipients.length} accounts with wrap.near`
  );

  // Step 5: Ensure DAO and genesis are registered with wrap.near and have tokens
  console.log("\n💰 Preparing DAO account...");
  await registerWithWrapNear(genesisAccount, daoAccountId);
  await registerWithWrapNear(genesisAccount, genesisAccount.accountId);
  // Also register intents.near with wrap.near so it can receive tokens
  await registerWithWrapNear(genesisAccount, CONFIG.INTENTS_CONTRACT_ID);

  // The token ID in intents.near is "nep141:wrap.near"
  const intentsTokenId = `nep141:${CONFIG.WRAP_TOKEN_ID}`;

  // Check DAO's multi-token balance in intents.near
  let daoTokenBalance = await getMultiTokenBalance(
    genesisAccount,
    daoAccountId,
    intentsTokenId
  );
  console.log(
    `📊 DAO ${intentsTokenId} balance in intents.near: ${daoTokenBalance}`
  );

  const totalRecipients = CONFIG.NUM_REGISTERED + CONFIG.NUM_NON_REGISTERED;
  const totalPaymentAmount =
    BigInt(CONFIG.PAYMENT_AMOUNT) * BigInt(totalRecipients);
  const requiredBalance = totalPaymentAmount * 2n; // 2x for safety

  if (BigInt(daoTokenBalance) < requiredBalance) {
    const neededTokens = requiredBalance - BigInt(daoTokenBalance);
    console.log(
      `📤 DAO needs ${neededTokens.toString()} more tokens in intents.near`
    );

    // First, ensure wrap.near has enough tokens
    console.log(`💵 Getting wNEAR tokens...`);
    await genesisAccount.functionCall({
      contractId: CONFIG.WRAP_TOKEN_ID,
      methodName: "near_deposit",
      args: {},
      gas: "30000000000000",
      attachedDeposit: (neededTokens + BigInt(parseNEAR("1"))).toString(), // Extra for fees
    });

    // Deposit tokens into intents.near (using ft_transfer_call on wrap.near)
    await depositToIntents(
      genesisAccount,
      genesisAccount.accountId,
      neededTokens.toString()
    );

    // Now transfer the multi-tokens to DAO
    await genesisAccount.functionCall({
      contractId: CONFIG.INTENTS_CONTRACT_ID,
      methodName: "mt_transfer",
      args: {
        receiver_id: daoAccountId,
        token_id: intentsTokenId,
        amount: neededTokens.toString(),
      },
      gas: "30000000000000",
      attachedDeposit: "1",
    });

    daoTokenBalance = await getMultiTokenBalance(
      genesisAccount,
      daoAccountId,
      intentsTokenId
    );
    console.log(`✅ DAO token balance in intents.near now: ${daoTokenBalance}`);
  }

  // Step 6: Ensure bulk payment contract is registered with wrap.near
  // (intents.near doesn't require storage registration)
  console.log(
    "\n📝 Ensuring bulk payment contract is registered with wrap.near..."
  );
  await registerWithWrapNear(genesisAccount, CONFIG.BULK_PAYMENT_CONTRACT_ID);

  // Step 7: Check and buy storage credits if needed
  const storageCost = calculateStorageCost(totalRecipients);
  console.log(
    `\n💰 Storage cost for ${totalRecipients} records: ${formatNEAR(storageCost)} NEAR`
  );

  let existingCredits = BigInt(0);
  try {
    const credits = await genesisAccount.viewFunction({
      contractId: CONFIG.BULK_PAYMENT_CONTRACT_ID,
      methodName: "view_storage_credits",
      args: { account_id: daoAccountId },
    });
    existingCredits = BigInt(credits || "0");
    console.log(
      `📊 Existing storage credits: ${formatNEAR(existingCredits.toString())} NEAR`
    );
  } catch (e) {
    console.log(`📊 No existing storage credits found`);
  }

  const storageCostBigInt = BigInt(storageCost);
  if (existingCredits < storageCostBigInt) {
    const additionalNeeded = storageCostBigInt - existingCredits;
    console.log(
      `📝 Need to buy additional storage: ${formatNEAR(additionalNeeded.toString())} NEAR`
    );

    // Use genesisAccount to buy storage on behalf of DAO
    await genesisAccount.functionCall({
      contractId: CONFIG.BULK_PAYMENT_CONTRACT_ID,
      methodName: "buy_storage",
      args: {
        num_records: totalRecipients,
        beneficiary_account_id: daoAccountId,
      },
      gas: "30000000000000",
      attachedDeposit: storageCost,
    });

    console.log(`✅ Storage purchased`);
  }

  // Step 8: Generate payment list
  console.log(`\n📋 Generating payment list...`);
  const testRunNonce = Date.now();
  const payments = [];

  // Add registered recipients
  for (let i = 0; i < registeredRecipients.length; i++) {
    const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
    const variation = BigInt((testRunNonce % 1000000) + i);
    payments.push({
      recipient: registeredRecipients[i],
      amount: (baseAmount + variation).toString(),
    });
  }

  // Add non-registered recipients
  for (let i = 0; i < nonRegisteredRecipients.length; i++) {
    const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
    const variation = BigInt(
      (testRunNonce % 1000000) + registeredRecipients.length + i
    );
    payments.push({
      recipient: nonRegisteredRecipients[i],
      amount: (baseAmount + variation).toString(),
    });
  }

  console.log(`✅ Generated ${payments.length} payments`);

  // Step 9: Generate list_id
  // Use nep141: prefix for NEAR Intents token format
  const tokenIdForList = `nep141:${CONFIG.WRAP_TOKEN_ID}`;
  const listId = generateListId(daoAccountId, tokenIdForList, payments);
  console.log(`\n🔑 Generated list_id: ${listId}`);
  console.log(`🔖 Token ID: ${tokenIdForList}`);

  const totalAmount = payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
  console.log(`💸 Total payment amount: ${totalAmount.toString()} tokens`);

  // Step 10: Create DAO proposal for mt_transfer_call BEFORE API submission
  // This is required - the API will verify this proposal exists
  console.log(
    "\n📝 Creating DAO proposal for mt_transfer_call before API submission..."
  );
  const mtTransferProposalId = await createProposal(
    genesisAccount,
    daoAccountId,
    `MT bulk payment list: ${listId}`, // Include list_id in description for verification
    CONFIG.INTENTS_CONTRACT_ID,
    "mt_transfer_call",
    {
      receiver_id: CONFIG.BULK_PAYMENT_CONTRACT_ID,
      token_id: tokenIdForList,
      amount: totalAmount.toString(),
      msg: listId, // list_id is passed as msg to mt_on_transfer
    },
    "1" // 1 yoctoNEAR for security
  );

  // Step 11: Submit payment list via API (requires DAO proposal to exist)
  // The API will verify the DAO proposal exists and track the list for the worker
  console.log("\n📤 Submitting payment list via API...");
  const submitResponse = await apiRequest("/submit-list", "POST", {
    list_id: listId,
    submitter_id: daoAccountId,
    dao_contract_id: daoAccountId,
    token_id: tokenIdForList,
    payments: payments,
  });

  assert.equal(
    submitResponse.success,
    true,
    `API submit must succeed: ${submitResponse.error}`
  );
  assert.equal(
    submitResponse.list_id,
    listId,
    "Returned list_id must match submitted"
  );
  console.log(`✅ Payment list submitted via API with ID: ${listId}`);

  // Step 12: Approve the DAO proposal (executes mt_transfer_call → mt_on_transfer)
  console.log("\n✅ Approving mt_transfer_call proposal...");
  await approveProposal(genesisAccount, daoAccountId, mtTransferProposalId);
  await sleep(2000); // Wait for execution

  console.log(`✅ Payment list approved via mt_transfer_call`);

  // Step 13: Wait for payout processing (background worker processes approved lists)
  console.log("\n⏳ Waiting for payout processing (API worker)...");
  let allProcessed = false;
  let attempts = 0;
  const maxAttempts = 60; // 5 minutes at 5-second intervals

  while (!allProcessed && attempts < maxAttempts) {
    await sleep(5000);
    attempts++;

    const currentStatus = await apiRequest(`/list/${listId}`);
    assert.equal(
      currentStatus.success,
      true,
      `Must be able to get list status: ${currentStatus.error}`
    );

    const { list } = currentStatus;
    const progress = (
      (list.processed_payments / list.total_payments) *
      100
    ).toFixed(1);
    console.log(
      `📊 Progress: ${list.processed_payments}/${list.total_payments} (${progress}%)`
    );

    // All payments are complete when there are no pending payments
    if (list.pending_payments === 0) {
      allProcessed = true;
    }
  }

  assert.equal(allProcessed, true, "All payments must complete within timeout");

  // Step 14: Verify all payments have block_height
  console.log("\n🔍 Verifying all payments have block_height...");
  const finalStatus = await viewPaymentList(genesisAccount, listId);

  const paymentsWithBlockHeight = finalStatus.payments.filter(
    (p) =>
      p.status && p.status.Paid && typeof p.status.Paid.block_height === "number"
  );

  console.log(
    `📊 Payments with block_height: ${paymentsWithBlockHeight.length}/${finalStatus.payments.length}`
  );

  assert.equal(
    paymentsWithBlockHeight.length,
    totalRecipients,
    `All ${totalRecipients} payments must have block_height registered`
  );
  console.log(`✅ All payments have block_height registered`);

  // Step 15: Verify token balance changes
  // For intents payments, we verify by checking token balances directly
  // After ft_withdraw from intents.near, tokens go to the underlying wrap.near contract
  console.log("\n💰 Verifying wrap.near token balance changes...");

  let successfulTransfers = [];
  let failedTransfers = [];

  for (const recipient of registeredRecipients) {
    const balance = await getWrapNearBalance(genesisAccount, recipient);
    const payment = payments.find((p) => p.recipient === recipient);

    console.log(
      `✅ Registered ${recipient.substring(0, 16)}...: wrap.near balance = ${balance}`
    );
    assert.ok(
      BigInt(balance) >= BigInt(payment.amount),
      `Registered account ${recipient} must have wrap.near balance >= ${payment.amount}, got ${balance}`
    );
    successfulTransfers.push({ recipient, isRegistered: true });
  }

  for (const recipient of nonRegisteredRecipients) {
    const balance = await getWrapNearBalance(genesisAccount, recipient);
    console.log(
      `ℹ️  Non-registered ${recipient.substring(0, 16)}...: wrap.near balance = ${balance}`
    );
    assert.equal(
      balance,
      "0",
      `Non-registered account ${recipient} must have 0 wrap.near balance, got ${balance}`
    );
    failedTransfers.push({ recipient, isRegistered: false });
  }

  // Step 16: Validate expectations
  console.log("\n=====================================");
  console.log("📊 Test Summary");
  console.log("=====================================");
  console.log(`Total Recipients: ${totalRecipients}`);
  console.log(`  - Registered: ${CONFIG.NUM_REGISTERED}`);
  console.log(`  - Non-Registered: ${CONFIG.NUM_NON_REGISTERED}`);
  console.log(`Payments with block_height: ${paymentsWithBlockHeight.length}`);
  console.log(`Successful transfers: ${successfulTransfers.length}`);
  console.log(`Failed transfers: ${failedTransfers.length}`);
  console.log("=====================================\n");

  // Assertions based on requirements
  assert.equal(
    paymentsWithBlockHeight.length,
    totalRecipients,
    "All payments must be processed with block_height"
  );

  // Registered accounts should have successful transfers
  const registeredSuccesses = successfulTransfers.filter(
    (t) => t.isRegistered
  ).length;
  assert.equal(
    registeredSuccesses,
    CONFIG.NUM_REGISTERED,
    "All registered accounts must have successful transfers"
  );

  // Non-registered accounts should have failed transfers
  const nonRegisteredFailures = failedTransfers.filter(
    (t) => !t.isRegistered
  ).length;
  assert.equal(
    nonRegisteredFailures,
    CONFIG.NUM_NON_REGISTERED,
    "All non-registered accounts must have failed transfers"
  );

  console.log(
    "🎉 Test PASSED: NEAR Intents payments behave correctly for non-registered accounts!"
  );
  console.log("   ✅ All payments marked as processed");
  console.log("   ✅ Registered accounts received tokens (verified via balance)");
  console.log("   ✅ Non-registered accounts have zero balance (transfer failed)");
  process.exit(0);
} catch (error) {
  console.error("❌ Test FAILED:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
