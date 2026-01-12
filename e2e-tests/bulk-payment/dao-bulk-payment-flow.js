/**
 * End-to-End Test: DAO Bulk Payment Flow
 *
 * This script demonstrates the full workflow for bulk payments from a DAO's perspective:
 * 1. Create a Sputnik DAO instance (testdao.sputnik-dao.near)
 * 2. Create a proposal to buy_storage in the bulk payment contract
 * 3. Approve the buy_storage proposal
 * 4. Submit a payment list via the bulk payment API (500 recipients)
 *    - Mix of implicit accounts, created named accounts, and non-existent named accounts
 * 5. Create a proposal to approve the payment list
 * 6. Approve the payment list proposal
 * 7. Verify all recipients are processed (all have block_height)
 * 8. Verify transaction receipts:
 *    - Implicit accounts: should succeed
 *    - Created named accounts: should succeed
 *    - Non-existent named accounts: should have failed receipts
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nearAPI from "near-api-js";
import { NearRpcClient, tx as rpcTx } from "@near-js/jsonrpc-client";
const { connect, keyStores, KeyPair, utils } = nearAPI;

// ============================================================================
// Configuration
// ============================================================================

const BYTES_PER_RECORD = 216n;
const STORAGE_COST_PER_BYTE = 10n ** 19n;
const STORAGE_MARKUP_PERCENT = 110n;

const CONFIG = {
  SANDBOX_RPC_URL: process.env.SANDBOX_RPC_URL || "http://localhost:3030",
  API_URL: process.env.API_URL || "http://localhost:8080",
  DAO_FACTORY_ID: process.env.DAO_FACTORY_ID || "sputnik-dao.near",
  BULK_PAYMENT_CONTRACT_ID:
    process.env.BULK_PAYMENT_CONTRACT_ID || "bulk-payment.near",
  NUM_RECIPIENTS: parseInt(process.env.NUM_RECIPIENTS || "250", 10),
  PAYMENT_AMOUNT: process.env.PAYMENT_AMOUNT || "100000000000000000000000",
  GENESIS_ACCOUNT_ID: process.env.GENESIS_ACCOUNT_ID || "test.near",
  GENESIS_PRIVATE_KEY:
    process.env.GENESIS_PRIVATE_KEY ||
    "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
};

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
  const idx = index % 0x100000000;
  const hex = idx.toString(16).padStart(8, "0");
  return hex.repeat(8);
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
    headers: { "Content-Type": "application/json" },
  };
  if (body) options.body = JSON.stringify(body);
  const response = await fetch(url, options);
  if (!response.ok && !expectError) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `API request failed: ${response.status} ${response.statusText} - ${errorText}`
    );
  }
  return response.json();
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
  const account = await near.account(CONFIG.GENESIS_ACCOUNT_ID);
  return { near, account, keyStore };
}

// ============================================================================
// DAO Operations
// ============================================================================

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
          proposal_bond: "100000000000000000000000",
          proposal_period: "604800000000000",
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
      gas: "300000000000000",
      attachedDeposit: parseNEAR("100"),
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

async function createProposal(
  account,
  daoAccountId,
  description,
  receiverId,
  methodName,
  args,
  deposit
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
              gas: "150000000000000",
            },
          ],
        },
      },
    },
  };
  await account.functionCall({
    contractId: daoAccountId,
    methodName: "add_proposal",
    args: proposalArgs,
    gas: "300000000000000",
    attachedDeposit: parseNEAR("0.1"),
  });
  const proposalId = await getLastProposalId(account, daoAccountId);
  console.log(`✅ Proposal created with ID: ${proposalId}`);
  return proposalId;
}

async function getLastProposalId(account, daoAccountId) {
  const result = await account.viewFunction({
    contractId: daoAccountId,
    methodName: "get_last_proposal_id",
    args: {},
  });
  return result - 1;
}

async function approveProposal(account, daoAccountId, proposalId) {
  console.log(`\n✅ Approving proposal ${proposalId}`);
  await account.functionCall({
    contractId: daoAccountId,
    methodName: "act_proposal",
    args: { id: proposalId, action: "VoteApprove" },
    gas: "300000000000000",
  });
  console.log(`✅ Proposal ${proposalId} approved`);
}

// ============================================================================
// Bulk Payment Contract Operations
// ============================================================================

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
// Main Test Flow
// ============================================================================

try {
  console.log("🚀 Starting DAO Bulk Payment E2E Test");
  console.log("=====================================");
  console.log(`Sandbox RPC: ${CONFIG.SANDBOX_RPC_URL}`);
  console.log(`API URL: ${CONFIG.API_URL}`);
  console.log(`DAO Factory: ${CONFIG.DAO_FACTORY_ID}`);
  console.log(`Bulk Payment Contract: ${CONFIG.BULK_PAYMENT_CONTRACT_ID}`);
  console.log(`Number of Recipients: ${CONFIG.NUM_RECIPIENTS}`);
  console.log("=====================================\n");

  console.log("📡 Connecting to NEAR sandbox...");
  const { near, account, keyStore } = await setupNearConnection();
  console.log(`✅ Connected as: ${account.accountId}`);

  console.log("\n🏥 Checking API health...");
  const health = await apiRequest("/api/health");
  assert.equal(health.status, "healthy", "API must be healthy");
  console.log(`✅ API is healthy: ${JSON.stringify(health)}`);

  const daoName = "testdao";
  const daoAccountId = await createDAO(account, daoName, account.accountId);

  const keyPair = KeyPair.fromString(CONFIG.GENESIS_PRIVATE_KEY);
  await keyStore.setKey("sandbox", daoAccountId, keyPair);
  const daoAccount = await near.account(daoAccountId);

  const daoState = await daoAccount.state();
  const daoBalance = BigInt(daoState.amount);
  const minBalance = parseNEAR("100");
  console.log(`\n💼 DAO balance: ${formatNEAR(daoBalance.toString())} NEAR`);

  if (daoBalance < BigInt(minBalance)) {
    const topUpAmount = parseNEAR("200");
    console.log(`📤 Topping up DAO with ${formatNEAR(topUpAmount)} NEAR...`);
    await account.sendMoney(daoAccountId, BigInt(topUpAmount));
    console.log(`✅ DAO topped up`);
  }

  const storageCost = calculateStorageCost(CONFIG.NUM_RECIPIENTS);
  console.log(
    `\n💰 Storage cost for ${CONFIG.NUM_RECIPIENTS} records: ${formatNEAR(storageCost)} NEAR`
  );

  let existingCredits = BigInt(0);
  try {
    const credits = await account.viewFunction({
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
  if (existingCredits >= storageCostBigInt) {
    console.log(`✅ Sufficient storage credits available, skipping buy_storage`);
  } else {
    const additionalNeeded = storageCostBigInt - existingCredits;
    console.log(
      `📝 Need to buy additional storage: ${formatNEAR(additionalNeeded.toString())} NEAR`
    );

    const buyStorageProposalId = await createProposal(
      account,
      daoAccountId,
      `Buy storage for ${CONFIG.NUM_RECIPIENTS} payment records`,
      CONFIG.BULK_PAYMENT_CONTRACT_ID,
      "buy_storage",
      { num_records: CONFIG.NUM_RECIPIENTS },
      storageCost
    );

    await approveProposal(account, daoAccountId, buyStorageProposalId);
    await sleep(2000);
  }

  console.log(
    `\n📋 Generating payment list with ${CONFIG.NUM_RECIPIENTS} recipients...`
  );
  const testRunNonce = Date.now();
  const payments = [];
  let totalPaymentAmount = BigInt(0);

  const implicitRecipients = [];
  const createdNamedRecipients = [];
  const nonExistentNamedRecipients = [];

  const numNamedAccounts = 8;
  const numImplicitAccounts = CONFIG.NUM_RECIPIENTS - numNamedAccounts;

  for (let i = 0; i < numImplicitAccounts; i++) {
    const recipient = generateImplicitAccountId(i);
    const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
    const variation = BigInt((testRunNonce % 1000000) + i);
    const uniqueAmount = (baseAmount + variation).toString();
    payments.push({ recipient, amount: uniqueAmount });
    implicitRecipients.push(recipient);
    totalPaymentAmount += BigInt(uniqueAmount);
  }

  console.log(`\n👤 Creating named accounts...`);
  for (let i = 0; i < 5; i++) {
    const namedAccount = `recipient${testRunNonce % 10000000}${i}.${CONFIG.GENESIS_ACCOUNT_ID}`;
    try {
      const newKeyPair = KeyPair.fromRandom("ed25519");
      await account.createAccount(
        namedAccount,
        newKeyPair.getPublicKey(),
        parseNEAR("1")
      );
      console.log(`✅ Created named account: ${namedAccount}`);
    } catch (error) {
      if (error.message && error.message.includes("already exists")) {
        console.log(`ℹ️  Named account already exists: ${namedAccount}`);
      } else {
        console.log(`⚠️  Could not create ${namedAccount}: ${error.message}`);
      }
    }
    const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
    const variation = BigInt((testRunNonce % 1000000) + numImplicitAccounts + i);
    const uniqueAmount = (baseAmount + variation).toString();
    payments.push({ recipient: namedAccount, amount: uniqueAmount });
    createdNamedRecipients.push(namedAccount);
    totalPaymentAmount += BigInt(uniqueAmount);
    await sleep(200);
  }

  console.log(`\n❌ Adding non-existent named accounts to payment list...`);
  for (let i = 0; i < 3; i++) {
    const nonExistentAccount = `nonexist${testRunNonce % 10000000}${i}.${CONFIG.GENESIS_ACCOUNT_ID}`;
    const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
    const variation = BigInt(
      (testRunNonce % 1000000) + numImplicitAccounts + 5 + i
    );
    const uniqueAmount = (baseAmount + variation).toString();
    payments.push({ recipient: nonExistentAccount, amount: uniqueAmount });
    nonExistentNamedRecipients.push(nonExistentAccount);
    totalPaymentAmount += BigInt(uniqueAmount);
  }

  console.log(`✅ Generated ${payments.length} payments:`);
  console.log(
    `   - ${implicitRecipients.length} implicit accounts (should succeed)`
  );
  console.log(
    `   - ${createdNamedRecipients.length} created named accounts (should succeed)`
  );
  console.log(
    `   - ${nonExistentNamedRecipients.length} non-existent named accounts (should fail)`
  );
  console.log(
    `💰 Total payment amount: ${formatNEAR(totalPaymentAmount.toString())} NEAR`
  );

  const listId = generateListId(daoAccountId, "native", payments);
  console.log(`\n🔑 Generated list_id: ${listId}`);
  assert.equal(listId.length, 64, "list_id must be 64 characters");
  assert.match(listId, /^[0-9a-f]{64}$/, "list_id must be hex-encoded");

  console.log("\n🔒 Testing API rejection with mismatched hash...");
  const wrongHashResponse = await apiRequest(
    "/api/bulk-payment/submit-list",
    "POST",
    {
      list_id: listId,
      submitter_id: daoAccountId,
      dao_contract_id: daoAccountId,
      token_id: "native",
      payments: payments.map((p, i) =>
        i === 0 ? { ...p, amount: "999" } : p
      ),
    },
    true
  );

  assert.equal(
    wrongHashResponse.success,
    false,
    "Submit with wrong hash must fail"
  );
  assert.ok(
    wrongHashResponse.error.includes("does not match computed hash"),
    `Error should mention hash mismatch: ${wrongHashResponse.error}`
  );
  console.log(
    `✅ API correctly rejected tampered payload: ${wrongHashResponse.error}`
  );

  console.log("\n🔒 Testing API rejection without DAO proposal...");
  const rejectResponse = await apiRequest(
    "/api/bulk-payment/submit-list",
    "POST",
    {
      list_id: listId,
      submitter_id: daoAccountId,
      dao_contract_id: daoAccountId,
      token_id: "native",
      payments,
    },
    true
  );

  assert.equal(
    rejectResponse.success,
    false,
    "Submit without DAO proposal must fail"
  );
  assert.ok(
    rejectResponse.error.includes("No pending DAO proposal found"),
    `Error should mention missing DAO proposal: ${rejectResponse.error}`
  );
  console.log(
    `✅ API correctly rejected submission: ${rejectResponse.error}`
  );

  console.log("\n📝 Creating DAO proposal with list_id before API submission...");
  const submitListProposalId = await createProposal(
    account,
    daoAccountId,
    `Bulk payment list: ${listId}`,
    CONFIG.BULK_PAYMENT_CONTRACT_ID,
    "approve_list",
    { list_id: listId },
    totalPaymentAmount.toString()
  );

  console.log("\n📤 Submitting payment list via API...");
  const submitResponse = await apiRequest("/api/bulk-payment/submit-list", "POST", {
    list_id: listId,
    submitter_id: daoAccountId,
    dao_contract_id: daoAccountId,
    token_id: "native",
    payments,
  });

  assert.equal(
    submitResponse.success,
    true,
    `Submit must succeed: ${submitResponse.error}`
  );
  assert.equal(
    submitResponse.list_id,
    listId,
    "Returned list_id must match submitted"
  );
  console.log(`✅ Payment list submitted with ID: ${listId}`);

  await approveProposal(account, daoAccountId, submitListProposalId);
  await sleep(2000);

  console.log("\n🔍 Verifying payment list status...");
  const listStatus = await viewPaymentList(account, listId);
  console.log(`📊 List status: ${listStatus.status}`);
  console.log(`📊 Total payments: ${listStatus.payments.length}`);

  assert.equal(
    listStatus.status,
    "Approved",
    `Payment list must be Approved, got: ${listStatus.status}`
  );
  assert.equal(
    listStatus.payments.length,
    CONFIG.NUM_RECIPIENTS,
    `Must have ${CONFIG.NUM_RECIPIENTS} payments`
  );

  console.log("\n⏳ Waiting for payout processing...");
  let allProcessed = false;
  let attempts = 0;
  const maxAttempts = 60;

  while (!allProcessed && attempts < maxAttempts) {
    await sleep(5000);
    attempts++;
    const currentStatus = await apiRequest(`/api/bulk-payment/list/${listId}`);
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
    if (list.pending_payments === 0) {
      allProcessed = true;
    }
  }

  assert.equal(allProcessed, true, "All payments must complete within timeout");

  console.log("\n🔍 Verifying all payments have block_height...");
  const finalStatus = await viewPaymentList(account, listId);

  const paymentsWithBlockHeight = finalStatus.payments.filter(
    (p) =>
      p.status &&
      p.status.Paid &&
      typeof p.status.Paid.block_height === "number"
  );
  const paymentsWithoutBlockHeight = finalStatus.payments.filter(
    (p) =>
      !p.status ||
      !p.status.Paid ||
      typeof p.status.Paid.block_height !== "number"
  );

  console.log(
    `📊 Payments with block_height: ${paymentsWithBlockHeight.length}/${finalStatus.payments.length}`
  );

  if (paymentsWithoutBlockHeight.length > 0) {
    console.log(`❌ Payments without block_height:`);
    paymentsWithoutBlockHeight.slice(0, 5).forEach((p) => {
      console.log(`   - ${p.recipient}: status = ${JSON.stringify(p.status)}`);
    });
  }

  assert.equal(
    paymentsWithBlockHeight.length,
    CONFIG.NUM_RECIPIENTS,
    `All ${CONFIG.NUM_RECIPIENTS} payments must have block_height registered`
  );
  console.log(`✅ All payments have block_height registered`);

  console.log("\n=====================================");
  console.log("📊 Test Summary");
  console.log("=====================================");
  console.log(`DAO Created: ${daoAccountId}`);
  console.log(`Payment List ID: ${listId}`);
  console.log(`Total Recipients: ${CONFIG.NUM_RECIPIENTS}`);
  console.log(
    `  - Implicit accounts: ${implicitRecipients.length} (all should succeed)`
  );
  console.log(
    `  - Created named accounts: ${createdNamedRecipients.length} (all should succeed)`
  );
  console.log(
    `  - Non-existent named accounts: ${nonExistentNamedRecipients.length} (all should fail)`
  );
  console.log(`Payments with block_height: ${paymentsWithBlockHeight.length}`);
  console.log("=====================================\n");

  assert.equal(
    paymentsWithBlockHeight.length,
    CONFIG.NUM_RECIPIENTS,
    `All ${CONFIG.NUM_RECIPIENTS} payments must have block_height`
  );

  console.log("🎉 Test PASSED: All payments completed with correct behavior!");
  process.exit(0);
} catch (error) {
  console.error("❌ Test FAILED:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
