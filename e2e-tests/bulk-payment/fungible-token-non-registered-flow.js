/**
 * End-to-End Test: Fungible Token Payments to Non-Registered Accounts
 *
 * This test demonstrates the behavior when making bulk payments with a fungible token (wrap.near)
 * to accounts that are not registered with the token contract.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as nearAPI from "near-api-js";
const { connect, keyStores, KeyPair, utils } = nearAPI;

// Configuration
const CONFIG = {
  SANDBOX_RPC_URL: process.env.SANDBOX_RPC_URL || "http://localhost:3030",
  API_URL: process.env.API_URL || "http://localhost:8080",
  DAO_ACCOUNT_ID: process.env.DAO_ACCOUNT_ID || "testdao.sputnik-dao.near",
  BULK_PAYMENT_CONTRACT_ID:
    process.env.BULK_PAYMENT_CONTRACT_ID || "bulk-payment.near",
  WRAP_TOKEN_ID: process.env.WRAP_TOKEN_ID || "wrap.near",
  NUM_REGISTERED: parseInt(process.env.NUM_REGISTERED || "5", 10),
  NUM_NON_REGISTERED: parseInt(process.env.NUM_NON_REGISTERED || "5", 10),
  PAYMENT_AMOUNT: process.env.PAYMENT_AMOUNT || "1000000000000000000000000",
  GENESIS_ACCOUNT_ID: process.env.GENESIS_ACCOUNT_ID || "test.near",
  GENESIS_PRIVATE_KEY:
    process.env.GENESIS_PRIVATE_KEY ||
    "ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB",
};

const BYTES_PER_RECORD = 216n;
const STORAGE_COST_PER_BYTE = 10n ** 19n;
const STORAGE_MARKUP_PERCENT = 110n;

// Utility functions
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

// NEAR connection setup
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

// DAO operations
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

async function getProposalStatus(account, daoAccountId, proposalId) {
  const proposal = await account.viewFunction({
    contractId: daoAccountId,
    methodName: "get_proposal",
    args: { id: proposalId },
  });
  return proposal.status;
}

// Fungible token operations
async function registerWithToken(account, tokenContractId, accountToRegister) {
  console.log(`📝 Registering ${accountToRegister} with ${tokenContractId}...`);

  try {
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

async function transferTokens(account, tokenContractId, receiverId, amount) {
  console.log(`💸 Transferring ${amount} tokens to ${receiverId}...`);

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

  console.log(`✅ Transferred ${amount} tokens`);
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

// Main test flow
(async () => {
  try {
    console.log("🚀 Starting Fungible Token Non-Registered Account E2E Test");
    console.log("==========================================================");
    console.log(`Sandbox RPC: ${CONFIG.SANDBOX_RPC_URL}`);
    console.log(`API URL: ${CONFIG.API_URL}`);
    console.log(`DAO Account: ${CONFIG.DAO_ACCOUNT_ID}`);
    console.log(`Bulk Payment Contract: ${CONFIG.BULK_PAYMENT_CONTRACT_ID}`);
    console.log(`Token Contract: ${CONFIG.WRAP_TOKEN_ID}`);
    console.log(`Registered Recipients: ${CONFIG.NUM_REGISTERED}`);
    console.log(`Non-Registered Recipients: ${CONFIG.NUM_NON_REGISTERED}`);
    console.log("==========================================================\n");

    console.log("📡 Connecting to NEAR sandbox...");
    const { near, genesisAccount, keyStore } = await setupNearConnection();
    console.log(`✅ Connected as genesis: ${genesisAccount.accountId}`);

    const daoAccountId = CONFIG.DAO_ACCOUNT_ID;
    console.log(`✅ Using DAO: ${daoAccountId}`);

    console.log("\n🏥 Checking API health...");
    const health = await apiRequest("/health");
    assert.equal(health.status, "healthy", "API must be healthy");
    console.log(`✅ API is healthy`);

    console.log(
      `\n👥 Generating ${CONFIG.NUM_REGISTERED + CONFIG.NUM_NON_REGISTERED} recipient accounts...`
    );
    const registeredRecipients = [];
    const nonRegisteredRecipients = [];

    const startIndex = Date.now() + 1000000;

    for (let i = 0; i < CONFIG.NUM_REGISTERED; i++) {
      const recipient = generateImplicitAccountId(startIndex + i);
      registeredRecipients.push(recipient);
    }

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

    console.log("\n📝 Registering accounts with token contract...");
    for (const recipient of registeredRecipients) {
      await registerWithToken(genesisAccount, CONFIG.WRAP_TOKEN_ID, recipient);
      await sleep(500);
    }
    console.log(`✅ Registered ${registeredRecipients.length} accounts`);

    console.log("\n💰 Preparing DAO account...");
    await registerWithToken(genesisAccount, CONFIG.WRAP_TOKEN_ID, daoAccountId);

    let daoTokenBalance = await getTokenBalance(
      genesisAccount,
      CONFIG.WRAP_TOKEN_ID,
      daoAccountId
    );
    console.log(`📊 DAO wNEAR balance: ${daoTokenBalance}`);

    const totalRecipients = CONFIG.NUM_REGISTERED + CONFIG.NUM_NON_REGISTERED;
    const totalPaymentAmount =
      BigInt(CONFIG.PAYMENT_AMOUNT) * BigInt(totalRecipients);
    const requiredBalance = totalPaymentAmount * 2n;

    if (BigInt(daoTokenBalance) < requiredBalance) {
      const neededTokens = requiredBalance - BigInt(daoTokenBalance);
      console.log(`📤 DAO needs ${neededTokens.toString()} more wNEAR tokens`);

      console.log(`💵 Depositing NEAR to get wNEAR...`);
      await genesisAccount.functionCall({
        contractId: CONFIG.WRAP_TOKEN_ID,
        methodName: "near_deposit",
        args: {},
        gas: "30000000000000",
        attachedDeposit: (neededTokens + BigInt(parseNEAR("1"))).toString(),
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
      console.log(`✅ DAO wNEAR balance now: ${daoTokenBalance}`);
    }

    console.log(
      "\n📝 Ensuring bulk payment contract is registered with token..."
    );
    await registerWithToken(
      genesisAccount,
      CONFIG.WRAP_TOKEN_ID,
      CONFIG.BULK_PAYMENT_CONTRACT_ID
    );

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

    console.log(`\n📋 Generating payment list...`);
    const testRunNonce = Date.now();
    const payments = [];

    for (let i = 0; i < registeredRecipients.length; i++) {
      const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
      const variation = BigInt((testRunNonce % 1000000) + i);
      payments.push({
        recipient: registeredRecipients[i],
        amount: (baseAmount + variation).toString(),
      });
    }

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

    const listId = generateListId(daoAccountId, CONFIG.WRAP_TOKEN_ID, payments);
    console.log(`\n🔑 Generated list_id: ${listId}`);

    const totalAmount = payments.reduce((sum, p) => sum + BigInt(p.amount), 0n);
    console.log(`💸 Total payment amount: ${totalAmount.toString()} tokens`);

    console.log(
      "\n📝 Creating DAO proposal for ft_transfer_call before API submission..."
    );
    const ftTransferProposalId = await createProposal(
      genesisAccount,
      daoAccountId,
      `FT bulk payment list: ${listId}`,
      CONFIG.WRAP_TOKEN_ID,
      "ft_transfer_call",
      {
        receiver_id: CONFIG.BULK_PAYMENT_CONTRACT_ID,
        amount: totalAmount.toString(),
        msg: listId,
      },
      "1"
    );

    console.log("\n📤 Submitting payment list via API...");
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
    assert.equal(
      submitResponse.list_id,
      listId,
      "Returned list_id must match submitted"
    );
    console.log(`✅ Payment list submitted via API with ID: ${listId}`);

    console.log("\n✅ Approving ft_transfer_call proposal...");
    await approveProposal(genesisAccount, daoAccountId, ftTransferProposalId);
    await sleep(2000);

    console.log(`✅ Payment list approved via ft_transfer_call`);

    console.log("\n⏳ Waiting for payout processing (API worker)...");
    let allProcessed = false;
    let attempts = 0;
    const maxAttempts = 60;

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

      if (list.pending_payments === 0) {
        allProcessed = true;
      }
    }

    assert.equal(allProcessed, true, "All payments must complete within timeout");

    console.log("\n🔍 Verifying all payments have block_height...");
    const finalStatus = await viewPaymentList(genesisAccount, listId);

    const paymentsWithBlockHeight = finalStatus.payments.filter(
      (p) =>
        p.status &&
        p.status.Paid &&
        typeof p.status.Paid.block_height === "number"
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

    console.log("\n💰 Verifying token balance changes...");
    let successfulTransfers = [];
    let failedTransfers = [];

    for (const recipient of registeredRecipients) {
      const balance = await getTokenBalance(
        genesisAccount,
        CONFIG.WRAP_TOKEN_ID,
        recipient
      );
      const payment = payments.find((p) => p.recipient === recipient);

      console.log(
        `✅ Registered ${recipient.substring(0, 16)}...: balance = ${balance}`
      );
      assert.ok(
        BigInt(balance) >= BigInt(payment.amount),
        `Registered account ${recipient} must have balance >= ${payment.amount}, got ${balance}`
      );
      successfulTransfers.push({ recipient, isRegistered: true, balance });
    }

    for (const recipient of nonRegisteredRecipients) {
      const balance = await getTokenBalance(
        genesisAccount,
        CONFIG.WRAP_TOKEN_ID,
        recipient
      );
      console.log(
        `ℹ️  Non-registered ${recipient.substring(0, 16)}...: balance = ${balance}`
      );
      assert.equal(
        balance,
        "0",
        `Non-registered account ${recipient} must have 0 balance, got ${balance}`
      );
      failedTransfers.push({ recipient, isRegistered: false, balance });
    }

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

    assert.equal(
      paymentsWithBlockHeight.length,
      totalRecipients,
      "All payments must be processed with block_height"
    );

    const registeredSuccesses = successfulTransfers.filter(
      (t) => t.isRegistered
    ).length;
    assert.equal(
      registeredSuccesses,
      CONFIG.NUM_REGISTERED,
      "All registered accounts must have successful transfers"
    );

    const nonRegisteredFailures = failedTransfers.filter(
      (t) => !t.isRegistered
    ).length;
    assert.equal(
      nonRegisteredFailures,
      CONFIG.NUM_NON_REGISTERED,
      "All non-registered accounts must have failed transfers"
    );

    console.log(
      "🎉 Test PASSED: Fungible token payments behave correctly for non-registered accounts!"
    );
    console.log("   ✅ All payments marked as processed");
    console.log("   ✅ Registered accounts received tokens successfully");
    console.log("   ✅ Non-registered accounts have failed receipts");
    process.exit(0);
  } catch (error) {
    console.error("❌ Test FAILED:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  }
})();
