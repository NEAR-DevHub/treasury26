/**
 * End-to-End Test: Large Fungible Token Batch (500 payments)
 *
 * This test verifies that the bulk payment system can handle large batches
 * of fungible token payments with dynamic gas metering.
 *
 * Test Scenario:
 * 1. Create 500 registered recipients
 * 2. Submit a payment list with wrap.near tokens
 * 3. Process payments in multiple batches (gas metering splits automatically)
 * 4. Verify all payments complete successfully
 *
 * Configuration:
 * - SANDBOX_RPC_URL: URL of the NEAR sandbox RPC (default: http://localhost:3030)
 * - API_URL: URL of the bulk payment API (default: http://localhost:8080)
 * - NUM_RECIPIENTS: Number of recipients (default: 500)
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
  DAO_ACCOUNT_ID: process.env.DAO_ACCOUNT_ID || "testdao.sputnik-dao.near",
  BULK_PAYMENT_CONTRACT_ID:
    process.env.BULK_PAYMENT_CONTRACT_ID || "bulk-payment.near",
  WRAP_TOKEN_ID: process.env.WRAP_TOKEN_ID || "wrap.near",

  // Test parameters - 50 recipients (reduced for fly.io rate limits)
  NUM_RECIPIENTS: parseInt(process.env.NUM_RECIPIENTS || "50", 10),
  PAYMENT_AMOUNT: process.env.PAYMENT_AMOUNT || "1000000000000000000000", // 0.001 wNEAR (smaller for 5000 payments)

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

async function createProposal(
  account,
  daoAccountId,
  description,
  receiverId,
  methodName,
  args,
  deposit,
  gas = "150000000000000"
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
              gas: gas,
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
    args: {
      id: proposalId,
      action: "VoteApprove",
    },
    gas: "300000000000000",
  });

  console.log(`✅ Proposal ${proposalId} approved`);
}

// ============================================================================
// Fungible Token Operations
// ============================================================================

async function registerWithToken(
  account,
  tokenContractId,
  accountToRegister,
  silent = false
) {
  // Just try to register - the contract will handle already registered accounts
  try {
    if (!silent) {
      console.log(`      Registering ${accountToRegister.substring(0, 16)}...`);
    }
    await account.functionCall({
      contractId: tokenContractId,
      methodName: "storage_deposit",
      args: {
        account_id: accountToRegister,
        registration_only: true,
      },
      gas: "30000000000000",
      attachedDeposit: parseNEAR("0.00125"),
    });
    return { registered: true, skipped: false };
  } catch (error) {
    if (error.message && error.message.includes("already registered")) {
      return { registered: true, skipped: true };
    }
    throw error;
  }
}

async function transferTokens(account, tokenContractId, receiverId, amount) {
  await account.functionCall({
    contractId: tokenContractId,
    methodName: "ft_transfer",
    args: {
      receiver_id: receiverId,
      amount: amount,
    },
    gas: "30000000000000",
    attachedDeposit: "1",
  });
}

async function getTokenBalance(account, tokenContractId, accountId) {
  try {
    const balance = await account.viewFunction({
      contractId: tokenContractId,
      methodName: "ft_balance_of",
      args: { account_id: accountId },
    });
    return balance;
  } catch (error) {
    return "0";
  }
}

// ============================================================================
// Main Test Flow
// ============================================================================

try {
  const startTime = Date.now();

  console.log("🚀 Starting Large Fungible Token Batch E2E Test");
  console.log("================================================");
  console.log(`Sandbox RPC: ${CONFIG.SANDBOX_RPC_URL}`);
  console.log(`API URL: ${CONFIG.API_URL}`);
  console.log(`DAO Account: ${CONFIG.DAO_ACCOUNT_ID}`);
  console.log(`Bulk Payment Contract: ${CONFIG.BULK_PAYMENT_CONTRACT_ID}`);
  console.log(`Token Contract: ${CONFIG.WRAP_TOKEN_ID}`);
  console.log(`Number of Recipients: ${CONFIG.NUM_RECIPIENTS}`);
  console.log(
    `Payment Amount per Recipient: ${formatNEAR(CONFIG.PAYMENT_AMOUNT)} wNEAR`
  );
  console.log("================================================\n");

  // Step 1: Setup NEAR connection
  console.log("📡 Connecting to NEAR sandbox...");
  const { near, genesisAccount, keyStore } = await setupNearConnection();
  console.log(`✅ Connected as genesis: ${genesisAccount.accountId}`);

  const daoAccountId = CONFIG.DAO_ACCOUNT_ID;
  console.log(`✅ Using DAO: ${daoAccountId}`);

  // Step 2: Check API health
  console.log("\n🏥 Checking API health...");
  const health = await apiRequest("/health");
  assert.equal(health.status, "healthy", "API must be healthy");
  console.log(`✅ API is healthy`);

  // Step 3: Generate recipient accounts
  console.log(`\n👥 Generating ${CONFIG.NUM_RECIPIENTS} recipient accounts...`);
  const generateStart = Date.now();
  const recipients = [];
  const startIndex = Date.now() + 5000000; // Unique offset for this test

  for (let i = 0; i < CONFIG.NUM_RECIPIENTS; i++) {
    const recipient = generateImplicitAccountId(startIndex + i);
    recipients.push(recipient);
    if ((i + 1) % 100 === 0) {
      console.log(`   Generated: ${i + 1}/${CONFIG.NUM_RECIPIENTS}`);
    }
  }
  const generateTime = ((Date.now() - generateStart) / 1000).toFixed(2);
  console.log(`\n✅ Generated ${recipients.length} recipients in ${generateTime}s`);

  // Step 4: Register all accounts with the token contract (sequential to avoid nonce conflicts)
  console.log("\n📝 Registering accounts with token contract...");
  const registerStart = Date.now();
  let registeredCount = 0;
  let skippedCount = 0;
  let newlyRegistered = 0;

  for (let i = 0; i < recipients.length; i++) {
    const recipient = recipients[i];
    console.log(
      `   [${i + 1}/${recipients.length}] Registering ${recipient.substring(0, 16)}...`
    );
    try {
      const result = await registerWithToken(
        genesisAccount,
        CONFIG.WRAP_TOKEN_ID,
        recipient,
        true
      );
      if (result.skipped) {
        skippedCount++;
      } else {
        newlyRegistered++;
      }
      registeredCount++;

      if ((i + 1) % 10 === 0) {
        const progress = ((registeredCount / recipients.length) * 100).toFixed(
          1
        );
        const elapsed = ((Date.now() - registerStart) / 1000).toFixed(0);
        const rate =
          registeredCount > 0
            ? (
                registeredCount /
                ((Date.now() - registerStart) / 1000)
              ).toFixed(1)
            : "0";
        console.log(
          `   ✓ ${registeredCount}/${recipients.length} (${progress}%) - ${newlyRegistered} new, ${skippedCount} skipped - ${elapsed}s - ${rate}/s`
        );
      }
    } catch (error) {
      console.error(
        `   [${i + 1}] ERROR registering ${recipient.substring(0, 16)}: ${error.message}`
      );
      throw error;
    }
  }
  const registerTime = ((Date.now() - registerStart) / 1000).toFixed(2);
  console.log(
    `\n✅ Processed ${registeredCount} accounts in ${registerTime}s (${newlyRegistered} new, ${skippedCount} already registered)`
  );

  // Step 5: Ensure DAO is registered and has tokens
  console.log("\n💰 Preparing DAO account...");
  await registerWithToken(genesisAccount, CONFIG.WRAP_TOKEN_ID, daoAccountId);

  let daoTokenBalance = await getTokenBalance(
    genesisAccount,
    CONFIG.WRAP_TOKEN_ID,
    daoAccountId
  );
  console.log(`📊 DAO wNEAR balance: ${formatNEAR(daoTokenBalance)}`);

  const totalPaymentAmount =
    BigInt(CONFIG.PAYMENT_AMOUNT) * BigInt(CONFIG.NUM_RECIPIENTS);
  const requiredBalance = totalPaymentAmount * 2n;

  if (BigInt(daoTokenBalance) < requiredBalance) {
    const neededTokens = requiredBalance - BigInt(daoTokenBalance);
    console.log(
      `📤 DAO needs ${formatNEAR(neededTokens.toString())} more wNEAR tokens`
    );

    console.log(`💵 Depositing NEAR to get wNEAR...`);
    await genesisAccount.functionCall({
      contractId: CONFIG.WRAP_TOKEN_ID,
      methodName: "near_deposit",
      args: {},
      gas: "30000000000000",
      attachedDeposit: (neededTokens + BigInt(parseNEAR("10"))).toString(),
    });

    await transferTokens(
      genesisAccount,
      CONFIG.WRAP_TOKEN_ID,
      daoAccountId,
      neededTokens.toString()
    );

    daoTokenBalance = await getTokenBalance(
      genesisAccount,
      CONFIG.WRAP_TOKEN_ID,
      daoAccountId
    );
    console.log(`✅ DAO wNEAR balance now: ${formatNEAR(daoTokenBalance)}`);
  }

  // Step 6: Ensure bulk payment contract is registered
  console.log("\n📝 Ensuring bulk payment contract is registered with token...");
  await registerWithToken(
    genesisAccount,
    CONFIG.WRAP_TOKEN_ID,
    CONFIG.BULK_PAYMENT_CONTRACT_ID
  );

  // Step 7: Buy storage credits
  const storageCost = calculateStorageCost(CONFIG.NUM_RECIPIENTS);
  console.log(
    `\n💰 Storage cost for ${CONFIG.NUM_RECIPIENTS} records: ${formatNEAR(storageCost)} NEAR`
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
      `📝 Buying storage: ${formatNEAR(additionalNeeded.toString())} NEAR`
    );

    await genesisAccount.functionCall({
      contractId: CONFIG.BULK_PAYMENT_CONTRACT_ID,
      methodName: "buy_storage",
      args: {
        num_records: CONFIG.NUM_RECIPIENTS,
        beneficiary_account_id: daoAccountId,
      },
      gas: "30000000000000",
      attachedDeposit: storageCost,
    });

    console.log(`✅ Storage purchased`);
  }

  // Step 8: Generate payment list
  console.log(
    `\n📋 Generating payment list with ${CONFIG.NUM_RECIPIENTS} payments...`
  );
  const paymentGenStart = Date.now();
  const testRunNonce = Date.now();
  const payments = [];

  for (let i = 0; i < recipients.length; i++) {
    const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
    const variation = BigInt((testRunNonce % 1000000) + i);
    payments.push({
      recipient: recipients[i],
      amount: (baseAmount + variation).toString(),
    });
    if ((i + 1) % 100 === 0) {
      console.log(`   Generated: ${i + 1}/${recipients.length} payments`);
    }
  }
  const paymentGenTime = ((Date.now() - paymentGenStart) / 1000).toFixed(2);
  console.log(`\n✅ Generated ${payments.length} payments in ${paymentGenTime}s`);

  // Step 9: Generate list_id
  console.log(
    `\n🔑 Generating list_id (hashing ${CONFIG.NUM_RECIPIENTS} payments)...`
  );
  const hashStart = Date.now();
  const listId = generateListId(daoAccountId, CONFIG.WRAP_TOKEN_ID, payments);
  const hashTime = ((Date.now() - hashStart) / 1000).toFixed(2);
  console.log(
    `✅ Generated list_id: ${listId.substring(0, 16)}... in ${hashTime}s`
  );

  const totalAmount = payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
  console.log(`💸 Total payment amount: ${formatNEAR(totalAmount.toString())} wNEAR`);

  // Step 10: Create DAO proposal for ft_transfer_call
  console.log("\n📝 Creating DAO proposal for ft_transfer_call...");
  const ftTransferProposalId = await createProposal(
    genesisAccount,
    daoAccountId,
    `FT bulk payment list (${CONFIG.NUM_RECIPIENTS} recipients): ${listId}`,
    CONFIG.WRAP_TOKEN_ID,
    "ft_transfer_call",
    {
      receiver_id: CONFIG.BULK_PAYMENT_CONTRACT_ID,
      amount: totalAmount.toString(),
      msg: listId,
    },
    "1"
  );

  // Step 11: Submit payment list via API
  console.log(
    `\n📤 Submitting payment list via API (${CONFIG.NUM_RECIPIENTS} payments)...`
  );
  const submitStart = Date.now();
  const submitResponse = await apiRequest("/submit-list", "POST", {
    list_id: listId,
    submitter_id: daoAccountId,
    dao_contract_id: daoAccountId,
    token_id: CONFIG.WRAP_TOKEN_ID,
    payments: payments,
  });

  assert.equal(
    submitResponse.success,
    true,
    `API submit must succeed: ${submitResponse.error}`
  );
  const submitTime = ((Date.now() - submitStart) / 1000).toFixed(2);
  console.log(`✅ Payment list submitted via API in ${submitTime}s`);

  // Step 12: Approve the DAO proposal
  console.log("\n✅ Approving ft_transfer_call proposal...");
  await approveProposal(genesisAccount, daoAccountId, ftTransferProposalId);
  await sleep(2000);
  console.log(`✅ Payment list approved`);

  // Step 13: Wait for payout processing
  console.log(
    "\n⏳ Waiting for payout processing (this will take multiple batches)..."
  );
  const payoutStart = Date.now();
  let allProcessed = false;
  let attempts = 0;
  const maxAttempts = 300; // 25 minutes at 5-second intervals (500 payments)
  let lastProcessed = 0;

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
    const progress = ((list.processed_payments / list.total_payments) * 100).toFixed(1);
    const elapsed = ((Date.now() - payoutStart) / 1000).toFixed(0);
    const rate =
      list.processed_payments > 0
        ? (list.processed_payments / ((Date.now() - payoutStart) / 1000)).toFixed(1)
        : "0";

    if (list.processed_payments !== lastProcessed) {
      console.log(
        `📊 Progress: ${list.processed_payments}/${list.total_payments} (${progress}%) - ${elapsed}s elapsed - ${rate} payments/s - pending: ${list.pending_payments}`
      );
      lastProcessed = list.processed_payments;
    }

    if (list.pending_payments === 0) {
      allProcessed = true;
    }
  }

  assert.equal(allProcessed, true, "All payments must complete within timeout");

  const payoutTime = ((Date.now() - payoutStart) / 1000).toFixed(2);
  console.log(`✅ Payout processing completed in ${payoutTime}s`);

  // Step 14: Verify all payments have block_height
  console.log("\n🔍 Verifying all payments have block_height...");
  const verifyStart = Date.now();
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
    CONFIG.NUM_RECIPIENTS,
    `All ${CONFIG.NUM_RECIPIENTS} payments must have block_height`
  );
  const verifyTime = ((Date.now() - verifyStart) / 1000).toFixed(2);
  console.log(
    `✅ All payments have block_height registered (verified in ${verifyTime}s)`
  );

  // Step 15: Verify sample of token balances
  console.log("\n💰 Verifying sample token balances (first 10 and last 10)...");
  const balanceVerifyStart = Date.now();
  const sampleRecipients = [
    ...recipients.slice(0, 10),
    ...recipients.slice(-10),
  ];
  let balancesChecked = 0;

  for (const recipient of sampleRecipients) {
    const balance = await getTokenBalance(
      genesisAccount,
      CONFIG.WRAP_TOKEN_ID,
      recipient
    );
    const payment = payments.find((p) => p.recipient === recipient);
    assert.ok(
      BigInt(balance) >= BigInt(payment.amount),
      `Recipient ${recipient.substring(0, 16)}... must have balance >= ${payment.amount}`
    );
    balancesChecked++;
    console.log(`   Verified: ${balancesChecked}/${sampleRecipients.length} balances`);
  }
  const balanceVerifyTime = ((Date.now() - balanceVerifyStart) / 1000).toFixed(
    2
  );
  console.log(`\n✅ Sample balances verified in ${balanceVerifyTime}s`);

  // Step 16: Summary
  const totalTime = ((Date.now() - startTime) / 1000 / 60).toFixed(2);

  // Count unique block heights to see how many batches were used
  const blockHeights = new Set(
    paymentsWithBlockHeight.map((p) => p.status.Paid.block_height)
  );

  console.log("\n=====================================");
  console.log("📊 Test Summary");
  console.log("=====================================");
  console.log(`Total Recipients: ${CONFIG.NUM_RECIPIENTS}`);
  console.log(`Payments Processed: ${paymentsWithBlockHeight.length}`);
  console.log(`Number of Batches: ${blockHeights.size}`);
  console.log(`Total Time: ${totalTime} minutes`);
  console.log(
    `Avg per batch: ${(CONFIG.NUM_RECIPIENTS / blockHeights.size).toFixed(0)} payments`
  );
  console.log("=====================================\n");

  console.log("🎉 Test PASSED: Large fungible token batch completed successfully!");
  console.log(`   ✅ ${CONFIG.NUM_RECIPIENTS} payments processed`);
  console.log(`   ✅ Distributed across ${blockHeights.size} batches`);
  console.log(`   ✅ All recipients received tokens`);
  process.exit(0);
} catch (error) {
  console.error("❌ Test FAILED:", error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}
