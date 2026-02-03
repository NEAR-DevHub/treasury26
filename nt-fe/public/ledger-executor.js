// Ledger Hardware Wallet Executor for hot-connect
// This script provides Ledger device integration for NEAR Protocol transactions

// Import dependencies from CDN
import TransportWebHID from "https://esm.sh/@ledgerhq/hw-transport-webhid@6.29.4";
import {
  baseEncode,
  baseDecode
} from "https://esm.sh/@near-js/utils@0.2.2";
import {
  Signature,
  createTransaction,
  encodeTransaction,
  SignedTransaction,
  actionCreators,
} from "https://esm.sh/@near-js/transactions@1.3.3";
import { PublicKey } from "https://esm.sh/@near-js/crypto@1.4.1";

// Destructure action creators for convenience
const {
  functionCall,
  transfer,
  addKey,
  deleteKey,
  createAccount,
  deleteAccount,
  stake,
  deployContract,
  fullAccessKey,
  functionCallAccessKey,
} = actionCreators;

// Ledger APDU constants
const CLA = 0x80; // Always the same for Ledger
const P1_LAST = 0x80; // End of Bytes to Sign (finalize)
const P1_MORE = 0x00; // More bytes coming
const P1_IGNORE = 0x00;
const P2_IGNORE = 0x00;
const CHUNK_SIZE = 250;
const NETWORK_ID = "W".charCodeAt(0); // 87

// Ledger NEAR instruction codes
const NEAR_INS = {
  GET_VERSION: 0x06,
  GET_PUBLIC_KEY: 0x04,
  GET_WALLET_ID: 0x05,
  SIGN_TRANSACTION: 0x02,
  NEP413_SIGN_MESSAGE: 0x07,
  NEP366_SIGN_DELEGATE_ACTION: 0x08,
};

// Default derivation path for NEAR
const DEFAULT_DERIVATION_PATH = "44'/397'/0'/0'/1'";

// Storage keys
const STORAGE_KEY_ACCOUNTS = "ledger:accounts";
const STORAGE_KEY_DERIVATION_PATH = "ledger:derivationPath";

/**
 * Converts BIP32-compliant derivation path to a Buffer
 * @param {string} derivationPath - e.g., "44'/397'/0'/0'/1'"
 * @returns {Uint8Array}
 */
function parseDerivationPath(derivationPath) {
  const parts = derivationPath.split("/");
  const buffers = [];

  for (const part of parts) {
    let value;
    if (part.endsWith("'")) {
      value = (Math.abs(parseInt(part.slice(0, -1))) | 0x80000000) >>> 0;
    } else {
      value = Math.abs(parseInt(part));
    }
    
    buffers.push(
      new Uint8Array([
        (value >> 24) & 0xff,
        (value >> 16) & 0xff,
        (value >> 8) & 0xff,
        value & 0xff,
      ])
    );
  }

  // Concatenate all buffers
  const totalLength = buffers.reduce((sum, buf) => sum + buf.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const buf of buffers) {
    result.set(buf, offset);
    offset += buf.length;
  }

  return result;
}

/**
 * LedgerClient class for APDU communication with Ledger device
 */
class LedgerClient {
  constructor() {
    this.transport = null;
  }

  isConnected() {
    return this.transport !== null;
  }

  async connect() {
    // Request new device (requires user gesture)
    this.transport = await TransportWebHID.create();
    this._setupDisconnectHandler();
  }

  async connectWithDevice(device) {
    // Connect to a specific already-authorized device
    this.transport = await TransportWebHID.open(device);
    this._setupDisconnectHandler();
  }

  _setupDisconnectHandler() {
    const handleDisconnect = () => {
      if (this.transport) {
        this.transport.off("disconnect", handleDisconnect);
      }
      this.transport = null;
    };

    this.transport.on("disconnect", handleDisconnect);
  }

  async disconnect() {
    if (!this.transport) {
      throw new Error("Device not connected");
    }

    await this.transport.close();
    this.transport = null;
  }

  async getVersion() {
    if (!this.transport) {
      throw new Error("Device not connected");
    }

    const res = await this.transport.send(
      CLA,
      NEAR_INS.GET_VERSION,
      P1_IGNORE,
      P2_IGNORE
    );

    const [major, minor, patch] = Array.from(res);
    return `${major}.${minor}.${patch}`;
  }

  async getPublicKey(derivationPath) {
    if (!this.transport) {
      throw new Error("Device not connected");
    }

    const res = await this.transport.send(
      CLA,
      NEAR_INS.GET_PUBLIC_KEY,
      P2_IGNORE,
      NETWORK_ID,
      parseDerivationPath(derivationPath)
    );

    return baseEncode(new Uint8Array(res.subarray(0, -2)));
  }

  async internalSign(data, derivationPath, ins) {
    if (!this.transport) {
      throw new Error("Device not connected");
    }

    // Reset state to avoid starting from partially filled buffer
    await this.getVersion();

    const pathBuffer = parseDerivationPath(derivationPath);
    const allData = new Uint8Array(pathBuffer.length + data.length);
    allData.set(pathBuffer, 0);
    allData.set(data, pathBuffer.length);

    for (let offset = 0; offset < allData.length; offset += CHUNK_SIZE) {
      const isLastChunk = offset + CHUNK_SIZE >= allData.length;
      const chunk = allData.subarray(offset, offset + CHUNK_SIZE);

      const response = await this.transport.send(
        CLA,
        ins,
        isLastChunk ? P1_LAST : P1_MORE,
        P2_IGNORE,
        chunk
      );

      if (isLastChunk) {
        return new Uint8Array(response.subarray(0, -2));
      }
    }

    throw new Error("Invalid data or derivation path");
  }

  async sign(data, derivationPath) {
    return this.internalSign(data, derivationPath, NEAR_INS.SIGN_TRANSACTION);
  }

  async signMessage(data, derivationPath) {
    return this.internalSign(data, derivationPath, NEAR_INS.NEP413_SIGN_MESSAGE);
  }
}

/**
 * Helper function to prompt user to connect Ledger device
 * This shows a button inside the sandbox iframe that provides the user gesture context
 * required by WebHID API
 */
async function promptForLedgerConnect(ledgerClient) {
  // First check if we already have device access (doesn't require user gesture)
  const existingDevices = await navigator.hid.getDevices();
  const ledgerDevice = existingDevices.find(
    (d) => d.vendorId === 0x2c97 // Ledger vendor ID
  );

  if (ledgerDevice) {
    // We already have permission, connect directly
    await ledgerClient.connectWithDevice(ledgerDevice);
    return;
  }

  // Need to request device access - show UI with button for user gesture
  await window.selector.ui.showIframe();

  const root = document.getElementById("root");
  root.style.display = "flex";
  
  root.innerHTML = `
    <div class="prompt-container" style="max-width: 400px; padding: 24px; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 16px;">🔐</div>
      <h1 style="margin-bottom: 16px;">Connect Ledger</h1>
      <p style="margin-bottom: 24px; color: #aaa;">
        Make sure your Ledger is connected via USB and the NEAR app is open.
      </p>
      <div style="display: flex; gap: 8px; justify-content: center;">
        <button id="cancelBtn" style="background: #444;">Cancel</button>
        <button id="connectBtn" style="background: #4c8bf5;">Connect Ledger</button>
      </div>
    </div>
  `;

  return new Promise((resolve, reject) => {
    const connectBtn = document.getElementById("connectBtn");
    const cancelBtn = document.getElementById("cancelBtn");

    connectBtn.addEventListener("click", async () => {
      try {
        // This click provides the user gesture context for WebHID
        await ledgerClient.connect();
        root.innerHTML = "";
        root.style.display = "none";
        window.selector.ui.hideIframe();
        resolve();
      } catch (error) {
        root.innerHTML = "";
        root.style.display = "none";
        window.selector.ui.hideIframe();
        reject(error);
      }
    });

    cancelBtn.addEventListener("click", () => {
      root.innerHTML = "";
      root.style.display = "none";
      window.selector.ui.hideIframe();
      reject(new Error("User cancelled"));
    });
  });
}

/**
 * Helper function to show account ID input dialog
 */
async function promptForAccountId() {
  await window.selector.ui.showIframe();

  const root = document.getElementById("root");
  root.style.display = "flex";
  
  root.innerHTML = `
    <div class="prompt-container" style="max-width: 400px; padding: 24px;">
      <h1 style="margin-bottom: 16px;">Enter Account ID</h1>
      <p style="margin-bottom: 16px; color: #aaa;">
        Ledger provides your public key. Please enter the NEAR account ID 
        that this key has full access to.
      </p>
      <input 
        type="text" 
        id="accountIdInput" 
        placeholder="example.near"
        style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #444; 
               background: #2c2c2c; color: #fff; font-size: 14px; margin-bottom: 16px;"
      />
      <div style="display: flex; gap: 8px; justify-content: flex-end;">
        <button id="cancelBtn" style="background: #444;">Cancel</button>
        <button id="confirmBtn" style="background: #4c8bf5;">Confirm</button>
      </div>
    </div>
  `;

  return new Promise((resolve, reject) => {
    const input = document.getElementById("accountIdInput");
    const confirmBtn = document.getElementById("confirmBtn");
    const cancelBtn = document.getElementById("cancelBtn");

    confirmBtn.addEventListener("click", () => {
      const accountId = input.value.trim();
      if (accountId) {
        root.innerHTML = "";
        root.style.display = "none";
        window.selector.ui.hideIframe();
        resolve(accountId);
      }
    });

    cancelBtn.addEventListener("click", () => {
      root.innerHTML = "";
      root.style.display = "none";
      window.selector.ui.hideIframe();
      reject(new Error("User cancelled"));
    });

    input.addEventListener("keypress", (e) => {
      if (e.key === "Enter") {
        confirmBtn.click();
      }
    });

    // Focus the input
    setTimeout(() => input.focus(), 100);
  });
}

/**
 * Helper function to fetch from RPC
 */
async function rpcRequest(network, method, params) {
  // Use FastNEAR RPC endpoints
  const rpcUrls = {
    mainnet: "https://rpc.mainnet.fastnear.com",
    testnet: "https://rpc.testnet.fastnear.com",
  };
  
  // Always use our known-good RPC endpoints
  const rpcUrl = rpcUrls[network] || rpcUrls.mainnet;
  
  const response = await fetch(rpcUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "dontcare",
      method,
      params,
    }),
  });

  const json = await response.json();
  
  if (json.error) {
    throw new Error(json.error.message || "RPC request failed");
  }

  return json.result;
}

/**
 * Verify that the public key has full access to the account
 */
async function verifyAccessKey(network, accountId, publicKey) {
  try {
    const accessKey = await rpcRequest(network, "query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: accountId,
      public_key: publicKey,
    });

    // Check if it's a full access key
    if (accessKey.permission !== "FullAccess") {
      throw new Error("The public key does not have FullAccess permission for this account");
    }

    return true;
  } catch (error) {
    if (error.message.includes("does not exist")) {
      throw new Error(`Access key not found for account ${accountId}. Please make sure the account exists and has the Ledger public key registered.`);
    }
    throw error;
  }
}

/**
 * Main Ledger Wallet implementation
 */
class LedgerWallet {
  constructor() {
    this.ledger = new LedgerClient();
    this.derivationPath = DEFAULT_DERIVATION_PATH;
  }

  /**
   * Sign in with Ledger device
   */
  async signIn(params) {
    try {
      // Prompt user to connect Ledger (provides user gesture for WebHID)
      await promptForLedgerConnect(this.ledger);

      // Get public key from Ledger
      const publicKeyString = await this.ledger.getPublicKey(this.derivationPath);
      const publicKey = `ed25519:${publicKeyString}`;

      // Prompt user for account ID
      const accountId = await promptForAccountId();

      // Verify the public key has access to the account
      const network = params?.network || "mainnet";
      await verifyAccessKey(network, accountId, publicKey);

      // Store the account information
      const accounts = [{ accountId, publicKey }];
      await window.selector.storage.set(STORAGE_KEY_ACCOUNTS, JSON.stringify(accounts));
      await window.selector.storage.set(STORAGE_KEY_DERIVATION_PATH, this.derivationPath);

      return accounts;
    } catch (error) {
      // Disconnect on error
      if (this.ledger.isConnected()) {
        await this.ledger.disconnect();
      }
      throw error;
    }
  }

  /**
   * Sign out and disconnect
   */
  async signOut() {
    if (this.ledger.isConnected()) {
      await this.ledger.disconnect();
    }
    
    await window.selector.storage.remove(STORAGE_KEY_ACCOUNTS);
    await window.selector.storage.remove(STORAGE_KEY_DERIVATION_PATH);

    return true;
  }

  /**
   * Get stored accounts
   */
  async getAccounts() {
    const accountsJson = await window.selector.storage.get(STORAGE_KEY_ACCOUNTS);
    if (!accountsJson) {
      return [];
    }

    try {
      return JSON.parse(accountsJson);
    } catch (error) {
      console.warn("Failed to parse stored accounts:", error);
      return [];
    }
  }

  /**
   * Sign and send a single transaction
   */
  async signAndSendTransaction(params) {
    const network = params.network || "mainnet";
    const accounts = await this.getAccounts();
    
    if (!accounts || accounts.length === 0) {
      throw new Error("No account connected");
    }

    const signerId = accounts[0].accountId;
    const { receiverId, actions } = params.transactions[0];

    // Connect to Ledger if not already connected
    if (!this.ledger.isConnected()) {
      await promptForLedgerConnect(this.ledger);
    }

    // Get current nonce and block hash
    const accessKey = await rpcRequest(network, "query", {
      request_type: "view_access_key",
      finality: "final",
      account_id: signerId,
      public_key: accounts[0].publicKey,
    });

    const block = await rpcRequest(network, "block", { finality: "final" });
    const blockHash = baseDecode(block.header.hash);

    // Build transaction actions
    const txActions = actions.map((action) => {
      if (action.type === "FunctionCall") {
        // Args should be passed as object or Uint8Array, not pre-stringified
        const args = action.params.args || {};
        return functionCall(
          action.params.methodName,
          args,
          BigInt(action.params.gas || "30000000000000"),
          BigInt(action.params.deposit || "0")
        );
      } else if (action.type === "Transfer") {
        return transfer(BigInt(action.params.deposit));
      } else if (action.type === "AddKey") {
        const publicKey = PublicKey.from(action.params.publicKey);
        const accessKey = action.params.accessKey;
        
        if (accessKey.permission === "FullAccess") {
          return addKey(publicKey, fullAccessKey());
        } else {
          return addKey(
            publicKey,
            functionCallAccessKey(
              accessKey.permission.receiverId,
              accessKey.permission.methodNames || [],
              BigInt(accessKey.permission.allowance || "0")
            )
          );
        }
      } else if (action.type === "DeleteKey") {
        const publicKey = PublicKey.from(action.params.publicKey);
        return deleteKey(publicKey);
      } else if (action.type === "CreateAccount") {
        return createAccount();
      } else if (action.type === "DeleteAccount") {
        return deleteAccount(action.params.beneficiaryId);
      } else if (action.type === "Stake") {
        const publicKey = PublicKey.from(action.params.publicKey);
        return stake(BigInt(action.params.stake), publicKey);
      } else if (action.type === "DeployContract") {
        return deployContract(action.params.code);
      }
      
      throw new Error(`Unsupported action type: ${action.type}`);
    });

    // Create transaction
    const transaction = createTransaction(
      signerId,
      PublicKey.from(accounts[0].publicKey),
      receiverId,
      accessKey.nonce + 1,
      txActions,
      blockHash
    );

    // Serialize and sign with Ledger
    const serializedTx = encodeTransaction(transaction);
    const signature = await this.ledger.sign(serializedTx, this.derivationPath);

    // Create signed transaction
    const signedTx = new SignedTransaction({
      transaction,
      signature: new Signature({
        keyType: transaction.publicKey.keyType,
        data: signature,
      }),
    });

    // Broadcast transaction (RPC expects base64 encoded signed transaction)
    const signedTxBytes = signedTx.encode();
    const base64Tx = btoa(String.fromCharCode(...signedTxBytes));
    const result = await rpcRequest(network, "broadcast_tx_commit", [base64Tx]);

    return result;
  }

  /**
   * Sign and send multiple transactions
   */
  async signAndSendTransactions(params) {
    const results = [];
    
    for (const tx of params.transactions) {
      const result = await this.signAndSendTransaction({
        ...params,
        transactions: [tx],
      });
      results.push(result);
    }

    return results;
  }

  /**
   * Sign a message (NEP-413)
   */
  async signMessage(params) {
    const accounts = await this.getAccounts();
    
    if (!accounts || accounts.length === 0) {
      throw new Error("No account connected");
    }

    // Connect to Ledger if not already connected
    if (!this.ledger.isConnected()) {
      await promptForLedgerConnect(this.ledger);
    }

    // Build NEP-413 message payload using borsh serialization
    const message = params.message;
    const recipient = params.recipient || "";
    const nonce = params.nonce || new Uint8Array(32);

    // NEP-413 payload structure (borsh serialized):
    // - message: string (4 bytes length + utf8 bytes)
    // - nonce: [u8; 32] (32 fixed bytes)
    // - recipient: string (4 bytes length + utf8 bytes)
    // - callback_url: Option<String> (1 byte for Some/None + optional string)

    // Manually construct borsh-serialized payload
    const messageBytes = new TextEncoder().encode(message);
    const recipientBytes = new TextEncoder().encode(recipient);

    // Calculate total size
    const payloadSize =
      4 + messageBytes.length +  // message (length + data)
      32 +                        // nonce (fixed 32 bytes)
      4 + recipientBytes.length + // recipient (length + data)
      1;                          // callback_url (0 = None)

    const payload = new Uint8Array(payloadSize);
    const view = new DataView(payload.buffer);
    let offset = 0;

    // Write message (length-prefixed string)
    view.setUint32(offset, messageBytes.length, true);
    offset += 4;
    payload.set(messageBytes, offset);
    offset += messageBytes.length;

    // Write nonce (32 fixed bytes)
    payload.set(nonce, offset);
    offset += 32;

    // Write recipient (length-prefixed string)
    view.setUint32(offset, recipientBytes.length, true);
    offset += 4;
    payload.set(recipientBytes, offset);
    offset += recipientBytes.length;

    // Write callback_url (Option<String> = None)
    payload[offset] = 0; // 0 = None

    // Sign with Ledger
    const signature = await this.ledger.signMessage(payload, this.derivationPath);

    // Convert signature to base64 (backend expects base64, not base58)
    const signatureBase64 = btoa(String.fromCharCode(...signature));

    return {
      accountId: accounts[0].accountId,
      publicKey: accounts[0].publicKey,
      signature: signatureBase64,
    };
  }
}

// Initialize and register the wallet with hot-connect
const wallet = new LedgerWallet();
window.selector.ready(wallet);
