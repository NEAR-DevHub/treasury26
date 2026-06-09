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
 * 
 * Configuration:
 * - SANDBOX_RPC_URL: URL of the NEAR sandbox RPC (default: http://localhost:3030)
 * - API_URL: URL of the bulk payment API (default: http://localhost:8080)
 * - DAO_FACTORY_ID: Sputnik DAO factory account (default: sputnik-dao.near)
 * - BULK_PAYMENT_CONTRACT_ID: Bulk payment contract account
 * 
 * Usage:
 * - Docker: npm run test:docker
 * - Fly.io: SANDBOX_RPC_URL=https://your-app.fly.dev:3030 API_URL=https://your-app.fly.dev:8080 npm run test:fly
 */

import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as nearAPI from 'near-api-js';
import { NearRpcClient, tx as rpcTx } from '@near-js/jsonrpc-client';
import { serialize } from 'borsh';
const { connect, keyStores, KeyPair, utils } = nearAPI;

// NEP-413 tag prefix: 2^31 + 413 = 2147484061
const NEP413_TAG = 2147484061;

// ============================================================================
// Configuration
// ============================================================================

// Storage cost calculation constants (matching bulk payment contract)
const BYTES_PER_RECORD = 216n; // AccountId (100) + amount (16) + status (~50) + overhead (~50)
const STORAGE_COST_PER_BYTE = 10n ** 19n; // yoctoNEAR per byte
const STORAGE_MARKUP_PERCENT = 110n; // 10% markup (110/100)

const CONFIG = {
  // URLs - configurable via environment variables
  SANDBOX_RPC_URL: process.env.SANDBOX_RPC_URL || 'http://localhost:3030',
  API_URL: process.env.API_URL || 'http://localhost:8080',
  
  // Contract IDs
  DAO_FACTORY_ID: process.env.DAO_FACTORY_ID || 'sputnik-dao.near',
  BULK_PAYMENT_CONTRACT_ID: process.env.BULK_PAYMENT_CONTRACT_ID || 'bulk-payment.near',
  
  // Test parameters
  // Note: 25 is the max per bulk payment API limit
  NUM_RECIPIENTS: parseInt(process.env.NUM_RECIPIENTS || '25', 10),
  PAYMENT_AMOUNT: process.env.PAYMENT_AMOUNT || '100000000000000000000000', // 0.1 NEAR per recipient
  
  // Genesis account credentials (default sandbox genesis account from near-sandbox-rs - PUBLIC TEST KEY)
  // See: https://github.com/near/near-sandbox-rs/blob/main/src/config.rs
  // This is the well-known sandbox test account key, safe for testing purposes only
  GENESIS_ACCOUNT_ID: process.env.GENESIS_ACCOUNT_ID || 'test.near',
  GENESIS_PRIVATE_KEY: process.env.GENESIS_PRIVATE_KEY || 'ed25519:3tgdk2wPraJzT4nsTuf86UX41xgPNk3MHnq8epARMdBNs29AFEztAuaQ7iHddDfXG9F2RzV1XNQYgJyAyoW51UBB',
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Parse NEAR amount to yoctoNEAR
 */
function parseNEAR(amount) {
  return utils.format.parseNearAmount(amount.toString());
}

/**
 * Format yoctoNEAR to NEAR
 */
function formatNEAR(yoctoNear) {
  return utils.format.formatNearAmount(yoctoNear, 4);
}

/**
 * Generate an implicit account ID (64 character hex string)
 */
function generateImplicitAccountId(index) {
  // Use modulo to ensure index fits in 8 hex digits (max 0xFFFFFFFF = 4,294,967,295)
  // This prevents overflow when using large timestamps
  const idx = index % 0x100000000;
  const hex = idx.toString(16).padStart(8, '0');
  return hex.repeat(8); // 64 characters
}

/**
 * Generate a valid list_id (64-char hex-encoded SHA-256 hash)
 * The API validates that list_id matches SHA-256(canonical_json(sorted_payments))
 * This ensures the payload matches the hash (integrity guarantee)
 * 
 * IMPORTANT: The hash must match the Rust API's serde_json serialization which:
 * 1. Sorts object keys alphabetically
 * 2. Sorts payments by recipient
 */
function generateListId(submitterId, tokenId, payments, timestamp) {
  // Sort payments by recipient for deterministic ordering (must match API)
  const sortedPayments = [...payments].sort((a, b) => a.recipient.localeCompare(b.recipient));

  // Create canonical JSON with alphabetically sorted keys (matches Rust serde_json)
  // Key order: payments, submitter, timestamp, token_id (alphabetical)
  // Payment key order: amount, recipient (alphabetical)
  const canonical = JSON.stringify({
    payments: sortedPayments.map(p => ({ amount: p.amount, recipient: p.recipient })),
    submitter: submitterId,
    timestamp: timestamp,
    token_id: tokenId,
  });

  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Sleep for specified milliseconds
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// NEP-413 Authentication
// ============================================================================

// Borsh schema for NEP-413 payload
const NEP413PayloadSchema = {
  struct: {
    message: 'string',
    nonce: { array: { type: 'u8', len: 32 } },
    recipient: 'string',
    callbackUrl: { option: 'string' },
  }
};

/**
 * Create NEP-413 signature for authentication
 * @param {KeyPair} keyPair - The signing key pair
 * @param {Uint8Array} nonce - Random 32-byte nonce
 * @param {string} recipient - The recipient (app identifier)
 * @param {string} message - The message to sign
 */
function signNep413(keyPair, nonce, recipient, message) {
  // Create NEP-413 payload
  const payload = {
    message,
    nonce: Array.from(nonce),
    recipient,
    callbackUrl: null,
  };

  // Borsh serialize the payload
  const serializedPayload = serialize(NEP413PayloadSchema, payload);

  // Prepend NEP-413 tag (2^31 + 413) as little-endian u32
  const tagBuffer = Buffer.alloc(4);
  tagBuffer.writeUInt32LE(NEP413_TAG, 0);

  // Concatenate tag + serialized payload
  const dataToHash = Buffer.concat([tagBuffer, Buffer.from(serializedPayload)]);

  // SHA256 hash
  const hash = createHash('sha256').update(dataToHash).digest();

  // Sign the hash
  const signature = keyPair.sign(hash);

  return {
    publicKey: keyPair.getPublicKey().toString(),
    signature: Buffer.from(signature.signature).toString('base64'),
    message,
    nonce: Buffer.from(nonce).toString('base64'),
    recipient,
    callbackUrl: null,
  };
}

// Global auth cookie storage
let authCookie = null;

/**
 * Authenticate with the API using NEP-413 signature
 * @param {KeyPair} keyPair - The signing key pair
 * @param {string} accountId - The account ID to authenticate as
 */
async function authenticate(keyPair, accountId) {
  console.log(`\n🔐 Authenticating as ${accountId}...`);

  // Step 1: Get challenge payload
  const challengeResponse = await fetch(`${CONFIG.API_URL}/api/auth/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!challengeResponse.ok) {
    throw new Error(`Challenge failed: ${await challengeResponse.text()}`);
  }

  const challengeData = await challengeResponse.json();
  const challengePayload = challengeData?.payload;
  if (typeof challengePayload !== 'string' || challengePayload.length === 0) {
    throw new Error(`Challenge response missing payload: ${JSON.stringify(challengeData)}`);
  }

  // Step 2: Sign challenge payload with NEP-413 fallback authorization format
  // The backend binds purpose and recipient as: "<PURPOSE>@<recipient>".
  const nonce = randomBytes(32);
  const authorization = signNep413(
    keyPair,
    nonce,
    'PROVE_OWNERSHIP@Trezu App',
    challengePayload,
  );

  // Step 3: Login with authorization
  const loginResponse = await fetch(`${CONFIG.API_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      accountId,
      authorization: JSON.stringify(authorization),
    }),
  });

  if (!loginResponse.ok) {
    throw new Error(`Login failed: ${await loginResponse.text()}`);
  }

  // Extract the auth cookie from Set-Cookie header
  const setCookie = loginResponse.headers.get('set-cookie');
  if (setCookie) {
    // Parse the cookie name=value part
    const cookieMatch = setCookie.match(/auth_token=([^;]+)/);
    if (cookieMatch) {
      authCookie = `auth_token=${cookieMatch[1]}`;
    }
  }

  if (!authCookie) {
    throw new Error('No auth cookie received from login');
  }

  const loginData = await loginResponse.json();
  console.log(`✅ Authenticated as ${loginData.accountId}`);

  return loginData;
}

/**
 * Make HTTP request to the bulk payment API
 * @param {string} endpoint - API endpoint
 * @param {string} method - HTTP method
 * @param {object} body - Request body
 * @param {boolean} expectError - If true, don't throw on non-2xx responses
 */
async function apiRequest(endpoint, method = 'GET', body = null, expectError = false) {
  const url = `${CONFIG.API_URL}${endpoint}`;
  const headers = {
    'Content-Type': 'application/json',
  };

  // Add auth cookie if we have one
  if (authCookie) {
    headers['Cookie'] = authCookie;
  }

  const options = {
    method,
    headers,
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);

  if (!response.ok && !expectError) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  // Try to parse JSON, but handle non-JSON responses gracefully
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    // Return a structured error for non-JSON responses
    return { success: false, error: text };
  }
}

/**
 * Ensure DAO membership is synced in backend DB for AuthUser.verify_dao_member checks.
 * Polls /api/user/treasuries until the DAO appears as isMember=true.
 */
async function waitForDaoMembershipSync(accountId, daoAccountId, timeoutMs = 60000) {
  console.log(`\n⏳ Waiting for DAO membership sync (${daoAccountId} -> ${accountId})...`);

  // Ensure DAO exists in backend tables and user has a row in dao_members.
  // This endpoint internally registers the DAO in `daos` (if missing).
  await apiRequest('/api/user/treasuries/save', 'POST', {
    accountId,
    daoId: daoAccountId,
  }, true);

  // Register/refresh monitored account (used by policy sync stale/active paths).
  await apiRequest('/api/monitored-accounts', 'POST', { accountId: daoAccountId }, true);

  // Explicitly mark dirty to trigger high-priority sync cycle.
  await apiRequest('/api/dao/mark-dirty', 'POST', { daoId: daoAccountId }, true);

  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const treasuries = await apiRequest(
      `/api/user/treasuries?accountId=${encodeURIComponent(accountId)}`,
      'GET',
      null,
      true,
    );

    if (Array.isArray(treasuries)) {
      const match = treasuries.find((t) => t.daoId === daoAccountId || t.dao_id === daoAccountId);
      if (match?.isMember === true || match?.is_member === true) {
        console.log('✅ DAO membership synced in backend');
        return;
      }
    }

    // Keep nudging dirty flag in case another process clears it before this DAO is synced.
    await apiRequest('/api/dao/mark-dirty', 'POST', { daoId: daoAccountId }, true);
    await sleep(2000);
  }

  throw new Error(`Timed out waiting for DAO membership sync for ${daoAccountId}`);
}

// ============================================================================
// NEAR Connection Setup
// ============================================================================

async function setupNearConnection() {
  const keyStore = new keyStores.InMemoryKeyStore();
  
  // Add genesis account key
  const keyPair = KeyPair.fromString(CONFIG.GENESIS_PRIVATE_KEY);
  await keyStore.setKey('sandbox', CONFIG.GENESIS_ACCOUNT_ID, keyPair);
  
  const connectionConfig = {
    networkId: 'sandbox',
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

/**
 * Create a Sputnik DAO instance
 */
async function createDAO(account, daoName, creatorAccountId) {
  console.log(`\n📋 Creating DAO: ${daoName}.${CONFIG.DAO_FACTORY_ID}`);
  
  const daoAccountId = `${daoName}.${CONFIG.DAO_FACTORY_ID}`;
  
  const createDaoArgs = {
    name: daoName,
    args: Buffer.from(JSON.stringify({
      config: {
        name: daoName,
        purpose: 'Testing bulk payments',
        metadata: '',
      },
      policy: {
        roles: [
          {
            kind: { Group: [creatorAccountId] },
            name: 'council',
            permissions: ['*:*'],
            vote_policy: {},
          },
        ],
        default_vote_policy: {
          weight_kind: 'RoleWeight',
          quorum: '0',
          threshold: [1, 2],
        },
        proposal_bond: '100000000000000000000000', // 0.1 NEAR
        proposal_period: '604800000000000', // 1 week in nanoseconds
        bounty_bond: '100000000000000000000000',
        bounty_forgiveness_period: '604800000000000',
      },
    })).toString('base64'),
  };
  
  try {
    const result = await account.functionCall({
      contractId: CONFIG.DAO_FACTORY_ID,
      methodName: 'create',
      args: createDaoArgs,
      gas: '300000000000000', // 300 TGas
      attachedDeposit: parseNEAR('100'), // 100 NEAR for DAO creation (needs funds for proposals)
    });
    
    console.log(`✅ DAO created: ${daoAccountId}`);
  } catch (error) {
    if (error.message && error.message.includes('already exists')) {
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
async function createProposal(account, daoAccountId, description, receiverId, methodName, args, deposit) {
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
              args: Buffer.from(JSON.stringify(args)).toString('base64'),
              deposit: deposit || '0',
              gas: '150000000000000', // 150 TGas
            },
          ],
        },
      },
    },
  };
  
  const result = await account.functionCall({
    contractId: daoAccountId,
    methodName: 'add_proposal',
    args: proposalArgs,
    gas: '300000000000000',
    attachedDeposit: parseNEAR('0.1'), // Proposal bond
  });
  
  // Proposal ID is typically logged or we can query it
  // For simplicity, assume proposals are sequential starting from 0
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
    methodName: 'get_last_proposal_id',
    args: {},
  });
  return result - 1; // get_last_proposal_id returns the next ID, so subtract 1
}

/**
 * Vote to approve a proposal
 */
async function approveProposal(account, daoAccountId, proposalId) {
  console.log(`\n✅ Approving proposal ${proposalId}`);

  // Fetch the proposal to get its kind (required by act_proposal in sputnik-dao v3)
  const proposalData = await account.viewFunction({
    contractId: daoAccountId,
    methodName: 'get_proposal',
    args: { id: proposalId },
  });

  await account.functionCall({
    contractId: daoAccountId,
    methodName: 'act_proposal',
    args: {
      id: proposalId,
      action: 'VoteApprove',
      proposal: proposalData.kind,
    },
    gas: '300000000000000',
  });

  console.log(`✅ Proposal ${proposalId} approved`);
}

// ============================================================================
// Bulk Payment Contract Operations
// ============================================================================

/**
 * Calculate storage cost for payment records
 */
function calculateStorageCost(numRecords) {
  // Uses constants defined at top of file
  const storageBytes = BYTES_PER_RECORD * BigInt(numRecords);
  const storageCost = storageBytes * STORAGE_COST_PER_BYTE;
  const totalCost = (storageCost * STORAGE_MARKUP_PERCENT) / 100n;
  return totalCost.toString();
}

/**
 * View payment list status
 */
async function viewPaymentList(account, listId) {
  const list = await account.viewFunction({
    contractId: CONFIG.BULK_PAYMENT_CONTRACT_ID,
    methodName: 'view_list',
    args: { list_id: listId },
  });
  return list;
}

// ============================================================================
// Main Test Flow (Top-Level Await)
// ============================================================================

try {
  console.log('🚀 Starting DAO Bulk Payment E2E Test');
  console.log('=====================================');
  console.log(`Sandbox RPC: ${CONFIG.SANDBOX_RPC_URL}`);
  console.log(`API URL: ${CONFIG.API_URL}`);
  console.log(`DAO Factory: ${CONFIG.DAO_FACTORY_ID}`);
  console.log(`Bulk Payment Contract: ${CONFIG.BULK_PAYMENT_CONTRACT_ID}`);
  console.log(`Number of Recipients: ${CONFIG.NUM_RECIPIENTS}`);
  console.log('=====================================\n');

// Step 1: Setup NEAR connection
console.log('📡 Connecting to NEAR sandbox...');
const { near, account, keyStore } = await setupNearConnection();
console.log(`✅ Connected as: ${account.accountId}`);

// Step 2: Check API health
console.log('\n🏥 Checking API health...');
const health = await apiRequest('/api/health');
assert.equal(health.status, 'healthy', 'API must be healthy');
console.log(`✅ API is healthy: ${JSON.stringify(health)}`);

// Step 2b: Authenticate with the API using NEP-413 signature
const authKeyPair = KeyPair.fromString(CONFIG.GENESIS_PRIVATE_KEY);
await authenticate(authKeyPair, account.accountId);

// Step 3: Create DAO
const daoName = 'testdao';
const daoAccountId = await createDAO(account, daoName, account.accountId);

// Add DAO key to keystore (uses same key as genesis for testing)
const keyPair = KeyPair.fromString(CONFIG.GENESIS_PRIVATE_KEY);
await keyStore.setKey('sandbox', daoAccountId, keyPair);
const daoAccount = await near.account(daoAccountId);

// Check DAO balance and top up if needed
const daoState = await daoAccount.state();
const daoBalance = BigInt(daoState.amount);
const minBalance = parseNEAR('100'); // Need at least 100 NEAR for operations
console.log(`\n💼 DAO balance: ${formatNEAR(daoBalance.toString())} NEAR`);

if (daoBalance < BigInt(minBalance)) {
  const topUpAmount = parseNEAR('200'); // Top up with 200 NEAR
  console.log(`📤 Topping up DAO with ${formatNEAR(topUpAmount)} NEAR...`);
  await account.sendMoney(daoAccountId, BigInt(topUpAmount));
  console.log(`✅ DAO topped up`);
}

// Step 4: Check existing storage credits and buy more if needed
const storageCost = calculateStorageCost(CONFIG.NUM_RECIPIENTS);
console.log(`\n💰 Storage cost for ${CONFIG.NUM_RECIPIENTS} records: ${formatNEAR(storageCost)} NEAR`);

// Check existing storage credits
let existingCredits = BigInt(0);
try {
  const credits = await account.viewFunction({
    contractId: CONFIG.BULK_PAYMENT_CONTRACT_ID,
    methodName: 'view_storage_credits',
    args: { account_id: daoAccountId },
  });
  existingCredits = BigInt(credits || '0');
  console.log(`📊 Existing storage credits: ${formatNEAR(existingCredits.toString())} NEAR`);
} catch (e) {
  console.log(`📊 No existing storage credits found`);
}

const storageCostBigInt = BigInt(storageCost);
if (existingCredits >= storageCostBigInt) {
  console.log(`✅ Sufficient storage credits available, skipping buy_storage`);
} else {
  const additionalNeeded = storageCostBigInt - existingCredits;
  console.log(`📝 Need to buy additional storage: ${formatNEAR(additionalNeeded.toString())} NEAR`);
  
  const buyStorageProposalId = await createProposal(
    account,
    daoAccountId,
    `Buy storage for ${CONFIG.NUM_RECIPIENTS} payment records`,
    CONFIG.BULK_PAYMENT_CONTRACT_ID,
    'buy_storage',
    { num_records: CONFIG.NUM_RECIPIENTS },
    storageCost // Buy full amount (contract handles credits)
  );

  // Step 5: Approve buy_storage proposal
  await approveProposal(account, daoAccountId, buyStorageProposalId);

  // Wait for execution
  await sleep(2000);
}

// Step 6: Generate payment list with unique amounts for each run
// Include: implicit accounts, created named accounts, and non-existent named accounts
console.log(`\n📋 Generating payment list with ${CONFIG.NUM_RECIPIENTS} recipients...`);
const testRunNonce = Date.now(); // Make each test run unique
const payments = [];
let totalPaymentAmount = BigInt(0);

// Track different types of recipients for later verification
const implicitRecipients = [];
const createdNamedRecipients = [];
const nonExistentNamedRecipients = [];

// Reserve slots for named accounts (5 created + 3 non-existent)
const numNamedAccounts = 8;
const numImplicitAccounts = CONFIG.NUM_RECIPIENTS - numNamedAccounts;

// Generate implicit account payments (these should succeed)
for (let i = 0; i < numImplicitAccounts; i++) {
  const recipient = generateImplicitAccountId(i);
  const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
  const variation = BigInt((testRunNonce % 1000000) + i);
  const uniqueAmount = (baseAmount + variation).toString();
  payments.push({
    recipient,
    amount: uniqueAmount,
  });
  implicitRecipients.push(recipient);
  totalPaymentAmount += BigInt(uniqueAmount);
}

// Create some named accounts that will exist (these should succeed)
console.log(`\n👤 Creating named accounts...`);
for (let i = 0; i < 5; i++) {
  // Use modulo 10000000 to create a sufficiently unique account name
  // This large modulus reduces the chance of collisions with previous test runs
  const namedAccount = `recipient${testRunNonce % 10000000}${i}.${CONFIG.GENESIS_ACCOUNT_ID}`;
  
  // Create the account as a subaccount
  try {
    const newKeyPair = KeyPair.fromRandom('ed25519');
    await account.createAccount(
      namedAccount,
      newKeyPair.getPublicKey(),
      parseNEAR('1') // 1 NEAR for initial balance
    );
    console.log(`✅ Created named account: ${namedAccount}`);
  } catch (error) {
    // Account might already exist, which is fine
    if (error.message && error.message.includes('already exists')) {
      console.log(`ℹ️  Named account already exists: ${namedAccount}`);
    } else {
      console.log(`⚠️  Could not create ${namedAccount}: ${error.message}`);
    }
  }
  
  const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
  const variation = BigInt((testRunNonce % 1000000) + numImplicitAccounts + i);
  const uniqueAmount = (baseAmount + variation).toString();
  payments.push({
    recipient: namedAccount,
    amount: uniqueAmount,
  });
  createdNamedRecipients.push(namedAccount);
  totalPaymentAmount += BigInt(uniqueAmount);
  
  await sleep(200); // Small delay between account creations
}

// Add non-existent named accounts (these should fail)
console.log(`\n❌ Adding non-existent named accounts to payment list...`);
for (let i = 0; i < 3; i++) {
  // Use "nonexist" prefix with large modulus to ensure these accounts don't exist
  // The modulo 10000000 creates unique names that shouldn't collide with existing accounts
  const nonExistentAccount = `nonexist${testRunNonce % 10000000}${i}.${CONFIG.GENESIS_ACCOUNT_ID}`;
  const baseAmount = BigInt(CONFIG.PAYMENT_AMOUNT);
  const variation = BigInt((testRunNonce % 1000000) + numImplicitAccounts + 5 + i);
  const uniqueAmount = (baseAmount + variation).toString();
  payments.push({
    recipient: nonExistentAccount,
    amount: uniqueAmount,
  });
  nonExistentNamedRecipients.push(nonExistentAccount);
  totalPaymentAmount += BigInt(uniqueAmount);
}

console.log(`✅ Generated ${payments.length} payments:`);
console.log(`   - ${implicitRecipients.length} implicit accounts (should succeed)`);
console.log(`   - ${createdNamedRecipients.length} created named accounts (should succeed)`);
console.log(`   - ${nonExistentNamedRecipients.length} non-existent named accounts (should fail)`);
console.log(`💰 Total payment amount: ${formatNEAR(totalPaymentAmount.toString())} NEAR`);

// Step 7: Generate list_id (64-char hex SHA-256 hash)
// Timestamp allows the same payment list to be submitted multiple times
const timestamp = Date.now();
const listId = generateListId(daoAccountId, 'native', payments, timestamp);
console.log(`\n🔑 Generated list_id: ${listId}`);
assert.equal(listId.length, 64, 'list_id must be 64 characters');
assert.match(listId, /^[0-9a-f]{64}$/, 'list_id must be hex-encoded');

// Step 7b: Verify API rejects submission with WRONG hash (payload doesn't match list_id)
console.log('\n🔒 Testing API rejection with mismatched hash...');
const wrongHashResponse = await apiRequest('/api/bulk-payment/submit-list', 'POST', {
  listId: listId,
  timestamp,
  submitterId: daoAccountId,
  daoContractId: daoAccountId,
  tokenId: 'native',
  // Tamper with payments - change first recipient's amount
  payments: payments.map((p, i) => i === 0 ? { ...p, amount: '999' } : p),
}, true); // expectError = true

assert.equal(wrongHashResponse.success, false, 'Submit with wrong hash must fail');
assert.ok(wrongHashResponse.error.includes('does not match computed hash'),
  `Error should mention hash mismatch: ${wrongHashResponse.error}`);
console.log(`✅ API correctly rejected tampered payload: ${wrongHashResponse.error}`);

// Step 8: Verify submit-list fails for a non-DAO-member account.
console.log('\n🔒 Testing submit-list rejection for non-DAO-member...');
const outsiderAccountId = `outsider${testRunNonce % 10000000}.${CONFIG.GENESIS_ACCOUNT_ID}`;
const outsiderKeyPair = KeyPair.fromRandom('ed25519');
await account.createAccount(
  outsiderAccountId,
  outsiderKeyPair.getPublicKey(),
  parseNEAR('1')
);
await authenticate(outsiderKeyPair, outsiderAccountId);
const nonMemberSubmitResponse = await apiRequest('/api/bulk-payment/submit-list', 'POST', {
  listId: listId,
  timestamp,
  submitterId: daoAccountId,
  daoContractId: daoAccountId,
  tokenId: 'native',
  payments,
}, true);
assert.equal(nonMemberSubmitResponse.success, false, 'Non-member submit must fail');
assert.ok(
  nonMemberSubmitResponse.error.includes("not allowed to perform 'AddProposal'"),
  `Error should mention AddProposal policy requirement: ${nonMemberSubmitResponse.error}`
);
console.log(`✅ Non-member submit rejected as expected: ${nonMemberSubmitResponse.error}`);

// Step 9: Re-authenticate as DAO member and wait for backend membership sync.
await authenticate(authKeyPair, account.accountId);
await waitForDaoMembershipSync(account.accountId, daoAccountId);

// Step 10: Submit payment list via API as DAO member.
// New flow: submit-list is validated by hash + DAO membership, not pending proposal existence.
console.log('\n📤 Submitting payment list via API...');
const submitResponse = await apiRequest('/api/bulk-payment/submit-list', 'POST', {
  listId: listId,
  timestamp,
  submitterId: daoAccountId,
  daoContractId: daoAccountId,
  tokenId: 'native',
  payments,
});

assert.equal(submitResponse.success, true, `Submit must succeed: ${submitResponse.error}`);
assert.equal(submitResponse.listId, listId, 'Returned listId must match submitted');
console.log(`✅ Payment list submitted with ID: ${listId}`);

// Step 11: Create DAO proposal with list_id after successful API submission
console.log('\n📝 Creating DAO proposal with list_id after API submission...');
const submitListProposalId = await createProposal(
  account,
  daoAccountId,
  `Bulk payment list: ${listId}`,
  CONFIG.BULK_PAYMENT_CONTRACT_ID,
  'approve_list',
  { list_id: listId },
  totalPaymentAmount.toString()
);

// Step 11b: Verify worker does NOT call payout_batch while list is still pending
// The list is submitted but not yet approved. Wait for several worker poll cycles
// (worker polls every 5s) then scan blocks for any payout_batch transactions.
console.log('\n🔍 Verifying worker does not call payout_batch on pending list...');

// Get current block height
const blockBeforeWait = await fetch(CONFIG.SANDBOX_RPC_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'block-before', method: 'block', params: { finality: 'final' } }),
}).then(r => r.json());
const startBlockHeight = blockBeforeWait.result.header.height;
console.log(`📊 Block height before wait: ${startBlockHeight}`);

// Wait for 3 worker poll cycles (15 seconds) to give the worker time to (incorrectly) act
await sleep(15000);

// Get block height after wait
const blockAfterWait = await fetch(CONFIG.SANDBOX_RPC_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 'block-after', method: 'block', params: { finality: 'final' } }),
}).then(r => r.json());
const endBlockHeight = blockAfterWait.result.header.height;
console.log(`📊 Block height after wait: ${endBlockHeight} (${endBlockHeight - startBlockHeight} blocks)`);

// Scan blocks for any payout_batch transactions to the bulk payment contract
let payoutBatchCallsFound = 0;
for (let h = startBlockHeight; h <= endBlockHeight; h++) {
  const chunkResult = await fetch(CONFIG.SANDBOX_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: `block-${h}`, method: 'block', params: { block_id: h } }),
  }).then(r => r.json());

  if (!chunkResult.result) continue;

  // Check each chunk for transactions targeting the bulk payment contract
  for (const chunk of chunkResult.result.chunks) {
    if (chunk.tx_root === '11111111111111111111111111111111') continue; // empty chunk

    // Fetch the full chunk to see transactions
    const chunkDetail = await fetch(CONFIG.SANDBOX_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: `chunk-${chunk.chunk_hash}`, method: 'chunk', params: { chunk_id: chunk.chunk_hash } }),
    }).then(r => r.json());

    if (!chunkDetail.result || !chunkDetail.result.transactions) continue;

    for (const tx of chunkDetail.result.transactions) {
      if (tx.receiver_id !== CONFIG.BULK_PAYMENT_CONTRACT_ID) continue;

      // Check if any action is a FunctionCall to payout_batch
      for (const action of tx.actions) {
        if (action.FunctionCall && action.FunctionCall.method_name === 'payout_batch') {
          payoutBatchCallsFound++;
          console.log(`   ❌ Found payout_batch call at block ${h} from ${tx.signer_id}`);
        }
      }
    }
  }
}

if (payoutBatchCallsFound > 0) {
  console.error(`\n❌ FAILURE: Worker called payout_batch ${payoutBatchCallsFound} time(s) on a pending (non-approved) list!`);
  process.exit(1);
}
console.log(`✅ No payout_batch calls found during ${endBlockHeight - startBlockHeight} blocks while list was pending`);

// Step 12: Approve the payment list proposal (created in Step 11)
await approveProposal(account, daoAccountId, submitListProposalId);

// Wait for execution
await sleep(2000);

// Step 13: Verify list is approved
console.log('\n🔍 Verifying payment list status...');
const listStatus = await viewPaymentList(account, listId);
console.log(`📊 List status: ${listStatus.status}`);
console.log(`📊 Total payments: ${listStatus.payments.length}`);

assert.equal(listStatus.status, 'Approved', `Payment list must be Approved, got: ${listStatus.status}`);
assert.equal(listStatus.payments.length, CONFIG.NUM_RECIPIENTS, `Must have ${CONFIG.NUM_RECIPIENTS} payments`);

// Step 14: Wait for payout processing (background worker processes approved lists)
console.log('\n⏳ Waiting for payout processing...');
let allProcessed = false;
let attempts = 0;
const maxAttempts = 60; // 5 minutes at 5-second intervals

while (!allProcessed && attempts < maxAttempts) {
  await sleep(5000);
  attempts++;
  
  const currentStatus = await apiRequest(`/api/bulk-payment/list/${listId}`);
  assert.equal(currentStatus.success, true, `Must be able to get list status: ${currentStatus.error}`);

  const { list } = currentStatus;
  const progress = ((list.processedPayments / list.totalPayments) * 100).toFixed(1);
  console.log(`📊 Progress: ${list.processedPayments}/${list.totalPayments} (${progress}%)`);

  // All payments are complete when there are no pending payments
  if (list.pendingPayments === 0) {
    allProcessed = true;
  }
}

assert.equal(allProcessed, true, 'All payments must complete within timeout');

// Step 15: Verify all payments have block_height registered
console.log('\n🔍 Verifying all payments have block_height...');
const finalStatus = await viewPaymentList(account, listId);

// Check that every payment has a block_height (status is {Paid: {block_height: N}})
const paymentsWithBlockHeight = finalStatus.payments.filter(p => 
  p.status && p.status.Paid && typeof p.status.Paid.block_height === 'number'
);
const paymentsWithoutBlockHeight = finalStatus.payments.filter(p => 
  !p.status || !p.status.Paid || typeof p.status.Paid.block_height !== 'number'
);

console.log(`📊 Payments with block_height: ${paymentsWithBlockHeight.length}/${finalStatus.payments.length}`);

if (paymentsWithoutBlockHeight.length > 0) {
  console.log(`❌ Payments without block_height:`);
  paymentsWithoutBlockHeight.slice(0, 5).forEach(p => {
    console.log(`   - ${p.recipient}: status = ${JSON.stringify(p.status)}`);
  });
}

assert.equal(
  paymentsWithBlockHeight.length, 
  CONFIG.NUM_RECIPIENTS, 
  `All ${CONFIG.NUM_RECIPIENTS} payments must have block_height registered`
);
console.log(`✅ All payments have block_height registered`);

// Step 16: Verify payment transactions using the API endpoint
console.log('\n🔗 Verifying payment transactions via API...');

// Verify ALL recipients (implicit, created named, and non-existent named)
const rpcClient = new NearRpcClient({ endpoint: CONFIG.SANDBOX_RPC_URL });
let implicitSuccesses = 0;
let namedSuccesses = 0;
let namedFailures = 0;
let allTransactionResults = [];

// Check all payments
for (const payment of finalStatus.payments) {
  const recipient = payment.recipient;
  const blockHeight = payment.status.Paid.block_height;
  
  const isImplicit = implicitRecipients.includes(recipient);
  const isCreatedNamed = createdNamedRecipients.includes(recipient);
  const isNonExistent = nonExistentNamedRecipients.includes(recipient);
  
  let recipientType = 'UNKNOWN';
  if (isImplicit) recipientType = 'IMPLICIT';
  else if (isCreatedNamed) recipientType = 'CREATED NAMED';
  else if (isNonExistent) recipientType = 'NON-EXISTENT NAMED';
  
  console.log(`\n📦 Checking ${recipientType}: ${recipient.substring(0, 30)}... (block ${blockHeight})`);
  
  // Get transaction hash from API
  const txResponse = await apiRequest(`/api/bulk-payment/list/${listId}/transaction/${recipient}`);
  
  // Fail immediately on API errors instead of silently continuing
  assert.equal(txResponse.success, true, 
    `API error for ${recipient}: ${txResponse.error || 'Unknown error'}`);
  
  const txHash = txResponse.transactionHash;
  console.log(`   Transaction hash: ${txHash.substring(0, 16)}...`);
  
  // Get transaction status
  const txStatus = await rpcTx(rpcClient, { txHash, senderAccountId: CONFIG.BULK_PAYMENT_CONTRACT_ID });
  
  // Check if THIS specific recipient has a failed receipt
  // In batched transactions, multiple recipients share the same transaction,
  // so we must filter for failures related to this specific recipient
  const recipientFailedReceipt = txStatus.receiptsOutcome.find(ro => {
    if (!ro.outcome.status?.Failure) return false;
    
    const failure = ro.outcome.status.Failure;
    
    // Check if the failure is for this specific recipient by looking at:
    // 1. The accountId in AccountDoesNotExist errors
    // 2. The receiver_id field on the receipt outcome
    const accountId = failure?.ActionError?.kind?.AccountDoesNotExist?.accountId;
    if (accountId === recipient) return true;
    
    // Also check receiver_id on the outcome
    if (ro.outcome.executor_id === recipient || ro.outcome.receiver_id === recipient) {
      return true;
    }
    
    return false;
  });
  
  if (recipientFailedReceipt) {
    console.log(`   ❌ Transaction failed for this recipient`);
    console.log(`      Failure: ${JSON.stringify(recipientFailedReceipt.outcome.status.Failure)}`);
    
    allTransactionResults.push({
      recipient,
      recipientType,
      blockHeight,
      txHash,
      success: false,
      failure: recipientFailedReceipt.outcome.status.Failure,
    });
    
    if (isNonExistent) {
      namedFailures++;
      console.log(`   ✅ Expected failure for non-existent account`);
    } else {
      // Unexpected failure for implicit or created named account
      assert.fail(`Unexpected failure for ${recipientType} account ${recipient}: ${JSON.stringify(recipientFailedReceipt.outcome.status.Failure)}`);
    }
  } else {
    console.log(`   ✅ Transaction succeeded for this recipient`);
    
    allTransactionResults.push({
      recipient,
      recipientType,
      blockHeight,
      txHash,
      success: true,
    });
    
    if (isImplicit) {
      implicitSuccesses++;
    } else if (isCreatedNamed) {
      namedSuccesses++;
    } else if (isNonExistent) {
      // Unexpected success for non-existent account
      assert.fail(`Unexpected success for non-existent account ${recipient}`);
    }
  }
  
  // Small delay to avoid overwhelming the RPC
  if (allTransactionResults.length % 10 === 0) {
    await sleep(500);
  }
}

console.log(`\n📊 Transaction verification summary:`);
console.log(`   Implicit accounts (successful): ${implicitSuccesses}/${implicitRecipients.length}`);
console.log(`   Created named accounts (successful): ${namedSuccesses}/${createdNamedRecipients.length}`);
console.log(`   Non-existent named accounts (failed): ${namedFailures}/${nonExistentNamedRecipients.length}`);

// Assertions based on requirements
assert.equal(implicitSuccesses, implicitRecipients.length, 
  'All implicit accounts must have successful transfers');
assert.equal(namedSuccesses, createdNamedRecipients.length, 
  'All created named accounts must have successful transfers');
assert.equal(namedFailures, nonExistentNamedRecipients.length, 
  'All non-existent named accounts must have failed transfers');

console.log(`✅ All transaction verifications passed!`);

// Step 17: Verify recipient balances for sample accounts
console.log('\n🔍 Verifying recipient balances for samples...');

// Sample a few from each category
const sampleImplicit = implicitRecipients.slice(0, 3);
const sampleCreated = createdNamedRecipients.slice(0, 2);

for (const recipient of sampleImplicit) {
  const payment = payments.find(p => p.recipient === recipient);
  const acc = await near.account(recipient);
  const balance = await acc.getAccountBalance();
  
  console.log(`✅ Implicit ${recipient.substring(0, 16)}...: ${formatNEAR(balance.total)} NEAR`);
  assert.ok(BigInt(balance.total) >= BigInt(payment.amount), 
    `Implicit account ${recipient} must have balance >= ${payment.amount}, got ${balance.total}`);
}

for (const recipient of sampleCreated) {
  const payment = payments.find(p => p.recipient === recipient);
  const acc = await near.account(recipient);
  const balance = await acc.getAccountBalance();
  
  console.log(`✅ Named ${recipient.substring(0, 30)}...: ${formatNEAR(balance.total)} NEAR`);
  assert.ok(BigInt(balance.total) >= BigInt(payment.amount), 
    `Named account ${recipient} must have balance >= ${payment.amount}, got ${balance.total}`);
}

// Step 18: Final verification
console.log('\n=====================================');
console.log('📊 Test Summary');
console.log('=====================================');
console.log(`DAO Created: ${daoAccountId}`);
console.log(`Payment List ID: ${listId}`);
console.log(`Total Recipients: ${CONFIG.NUM_RECIPIENTS}`);
console.log(`  - Implicit accounts: ${implicitRecipients.length} (all should succeed)`);
console.log(`  - Created named accounts: ${createdNamedRecipients.length} (all should succeed)`);
console.log(`  - Non-existent named accounts: ${nonExistentNamedRecipients.length} (all should fail)`);
console.log(`Payments with block_height: ${paymentsWithBlockHeight.length}`);
console.log(`Successful implicit transfers: ${implicitSuccesses}/${implicitRecipients.length}`);
console.log(`Successful named transfers: ${namedSuccesses}/${createdNamedRecipients.length}`);
console.log(`Failed non-existent transfers: ${namedFailures}/${nonExistentNamedRecipients.length}`);
console.log('=====================================\n');

// Hard assertions
assert.equal(paymentsWithBlockHeight.length, CONFIG.NUM_RECIPIENTS, 
  `All ${CONFIG.NUM_RECIPIENTS} payments must have block_height`);

console.log('🎉 Test PASSED: All payments completed with correct behavior!');
process.exit(0);

} catch (error) {
  console.error('❌ Test FAILED:', error.message);
  if (error.stack) {
    console.error(error.stack);
  }
  process.exit(1);
}

