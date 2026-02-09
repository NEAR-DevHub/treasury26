// Ledger Hardware Wallet Executor for hot-connect
// This script provides Ledger device integration for NEAR Protocol transactions

// Import dependencies from CDN
import TransportWebHID from "https://esm.sh/@ledgerhq/hw-transport-webhid@6.29.4";
import TransportWebUSB from "https://esm.sh/@ledgerhq/hw-transport-webusb@6.29.4";
import { baseEncode, baseDecode } from "https://esm.sh/@near-js/utils@0.2.2";
import {
    Signature,
    createTransaction,
    encodeTransaction,
    SignedTransaction,
    actionCreators,
} from "https://esm.sh/@near-js/transactions@1.3.3";
import { PublicKey } from "https://esm.sh/@near-js/crypto@1.4.1";
import { Buffer } from "https://esm.sh/buffer@6.0.3";

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

// Ledger OS (BOLOS) constants for app management
const BOLOS_CLA = 0xb0;
const BOLOS_INS_GET_APP_NAME = 0x01;
const BOLOS_INS_QUIT_APP = 0xa7;

// Ledger app open constants
const APP_OPEN_CLA = 0xe0;
const APP_OPEN_INS = 0xd8;

// Select transport based on browser support: prefer WebHID, fall back to WebUSB
const useWebHID = !!navigator?.hid;
const Transport = useWebHID ? TransportWebHID : TransportWebUSB;

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
            ]),
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
        this.transport = await Transport.create();
        this._setupDisconnectHandler();
    }

    async connectWithDevice(device) {
        // Connect to a specific already-authorized device
        this.transport = await Transport.open(device);
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
            P2_IGNORE,
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
            parseDerivationPath(derivationPath),
        );
        const array = new Uint8Array(res.subarray(0, -2));

        return baseEncode(array);
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
                chunk,
            );

            if (isLastChunk) {
                return new Uint8Array(response.subarray(0, -2));
            }
        }

        throw new Error("Invalid data or derivation path");
    }

    async sign(data, derivationPath) {
        return this.internalSign(
            data,
            derivationPath,
            NEAR_INS.SIGN_TRANSACTION,
        );
    }

    async signMessage(data, derivationPath) {
        return this.internalSign(
            data,
            derivationPath,
            NEAR_INS.NEP413_SIGN_MESSAGE,
        );
    }

    /**
     * Get the name of the currently running app on the Ledger
     * @returns {Promise<string>} The app name (e.g., "NEAR", "BOLOS" for dashboard)
     */
    async getRunningAppName() {
        if (!this.transport) {
            throw new Error("Device not connected");
        }

        const res = await this.transport.send(
            BOLOS_CLA,
            BOLOS_INS_GET_APP_NAME,
            P1_IGNORE,
            P2_IGNORE,
        );

        // Response format: format u8, name length u8, name bytes
        const nameLength = res[1];
        const nameBytes = res.subarray(2, 2 + nameLength);
        return new TextDecoder().decode(nameBytes);
    }

    /**
     * Quit the currently open application on the Ledger
     */
    async quitOpenApplication() {
        if (!this.transport) {
            throw new Error("Device not connected");
        }

        await this.transport.send(
            BOLOS_CLA,
            BOLOS_INS_QUIT_APP,
            P1_IGNORE,
            P2_IGNORE,
        );
    }

    /**
     * Open the NEAR application on the Ledger device
     * This checks if NEAR is already running, quits any other app if needed,
     * and opens the NEAR app
     */
    async openNearApplication() {
        if (!this.transport) {
            throw new Error("Device not connected");
        }

        const runningApp = await this.getRunningAppName();

        if (runningApp === "NEAR") {
            // NEAR app already running
            return;
        }

        if (runningApp !== "BOLOS") {
            // Another app is running, quit it first
            await this.quitOpenApplication();
            // Wait for the Ledger to close the app
            await new Promise((resolve) => setTimeout(resolve, 1000));
        }

        // Open the NEAR app
        const nearAppName = new TextEncoder().encode("NEAR");
        try {
            await this.transport.send(
                APP_OPEN_CLA,
                APP_OPEN_INS,
                0x00,
                0x00,
                nearAppName,
            );
        } catch (error) {
            // Check for specific error codes in the error message
            const errorMsg = error.message || "";
            if (errorMsg.includes("6807")) {
                throw new Error(
                    "NEAR application is missing on the Ledger device",
                );
            }
            if (errorMsg.includes("5501")) {
                throw new Error("User declined to open the NEAR app");
            }
            throw error;
        }
    }
}

/**
 * Get user-friendly error message for Ledger errors
 */
function getLedgerErrorMessage(error) {
    const errorMsg = error.message || "";

    if (errorMsg.includes("0xb005") || errorMsg.includes("UNKNOWN_ERROR")) {
        return "Please make sure your Ledger device is unlocked and the NEAR app is open. You may need to approve the action on your device.";
    }
    if (errorMsg.includes("0x5515") || errorMsg.includes("Locked device")) {
        return "Your Ledger device is locked. Please unlock it and try again.";
    }
    if (errorMsg.includes("6807") || errorMsg.includes("missing")) {
        return "NEAR application is not installed on your Ledger device. Please install it using Ledger Live.";
    }
    if (errorMsg.includes("5501") || errorMsg.includes("declined")) {
        return "You declined to open the NEAR app. Please try again and approve on your device.";
    }
    if (errorMsg.includes("No device selected")) {
        return "No Ledger device was selected. Please try again and select your device.";
    }

    return errorMsg || "An unknown error occurred. Please try again.";
}

/**
 * Helper function to prompt user to connect Ledger device
 * This shows a button inside the sandbox iframe that provides the user gesture context
 * required by WebHID API
 */
async function promptForLedgerConnect(ledgerClient) {
    // First check if we already have device access (doesn't require user gesture)
    const existingDevices = useWebHID
        ? await navigator?.hid?.getDevices()
        : await navigator?.usb?.getDevices();
    const ledgerDevice = existingDevices.find(
        (d) => d.vendorId === 0x2c97, // Ledger vendor ID
    );

    let initialError = null;

    if (ledgerDevice) {
        // We already have permission, try to connect directly
        try {
            await ledgerClient.connectWithDevice(ledgerDevice);
            // Ensure NEAR app is open
            await ledgerClient.openNearApplication();
            return;
        } catch (error) {
            // Connection failed, disconnect to ensure clean state
            if (ledgerClient.isConnected()) {
                try {
                    await ledgerClient.disconnect();
                } catch {
                    // Ignore disconnect errors
                }
            }
            // Show UI with error
            initialError = getLedgerErrorMessage(error);
        }
    }

    // Need to request device access - show UI with button for user gesture
    await window.selector.ui.showIframe();

    const root = document.getElementById("root");
    root.style.display = "flex";

    function renderUI(errorMessage = null) {
        root.innerHTML = `
        <div class="prompt-container" style="max-width: 400px; padding: 24px; text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">${errorMessage ? "⚠️" : "🔐"}</div>
          <h1 style="margin-bottom: 16px;">${errorMessage ? "Connection Failed" : "Connect Ledger"}</h1>
          ${
              errorMessage
                  ? `
          <div style="background: #3d2020; border: 1px solid #5c3030; border-radius: 8px; padding: 12px; margin-bottom: 16px; text-align: left;">
            <p style="color: #ff8080; font-size: 13px; margin: 0;">${errorMessage}</p>
          </div>
          `
                  : ""
          }
          <p style="margin-bottom: 24px; color: #aaa;">
            Make sure your Ledger is connected via USB and the NEAR app is open.
          </p>
          <div style="display: flex; gap: 8px; justify-content: center;">
            <button id="cancelBtn" style="background: #444;">Cancel</button>
            <button id="connectBtn" style="background: #4c8bf5;">${errorMessage ? "Try Again" : "Connect Ledger"}</button>
          </div>
        </div>
      `;
    }

    renderUI(initialError);

    return new Promise((resolve, reject) => {
        function setupListeners() {
            const connectBtn = document.getElementById("connectBtn");
            const cancelBtn = document.getElementById("cancelBtn");

            connectBtn.addEventListener("click", async () => {
                // Show loading state
                connectBtn.disabled = true;
                connectBtn.textContent = "Connecting...";

                try {
                    // Disconnect first to ensure clean state
                    if (ledgerClient.isConnected()) {
                        try {
                            await ledgerClient.disconnect();
                        } catch {
                            // Ignore disconnect errors
                        }
                    }
                    // This click provides the user gesture context for WebHID
                    await ledgerClient.connect();
                    // Ensure NEAR app is open
                    await ledgerClient.openNearApplication();
                    // Don't hide iframe - let next UI (derivation path) take over smoothly
                    resolve();
                } catch (error) {
                    // Disconnect on failure to ensure clean state
                    if (ledgerClient.isConnected()) {
                        try {
                            await ledgerClient.disconnect();
                        } catch {
                            // Ignore disconnect errors
                        }
                    }
                    // Show error in UI and allow retry
                    const friendlyError = getLedgerErrorMessage(error);
                    renderUI(friendlyError);
                    setupListeners();
                }
            });

            cancelBtn.addEventListener("click", () => {
                root.innerHTML = "";
                root.style.display = "none";
                window.selector.ui.hideIframe();
                reject(new Error("User cancelled"));
            });
        }

        setupListeners();
    });
}

/**
 * Helper function to show derivation path selection UI
 * @param {string} currentPath - Current derivation path
 * @returns {Promise<string>} - Selected derivation path
 */
async function promptForDerivationPath(currentPath = DEFAULT_DERIVATION_PATH) {
    await window.selector.ui.showIframe();

    const root = document.getElementById("root");
    root.style.display = "flex";

    let showCustom = false;

    function renderUI() {
        root.innerHTML = `
        <div class="prompt-container" style="max-width: 380px; padding: 20px; box-sizing: border-box; overflow: hidden;">
          <h1 style="margin: 0 0 12px 0; font-size: 18px;">Select Derivation Path</h1>
          <p style="margin: 0 0 12px 0; color: #aaa; font-size: 13px;">
            Choose which account index to use from your Ledger device.
          </p>
          <div style="display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px;">
            <button
              id="path0Btn"
              class="path-btn"
              data-path="44'/397'/0'/0'/0'"
              style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid ${currentPath === "44'/397'/0'/0'/0'" ? "#4c8bf5" : "#444"};
                     background: ${currentPath === "44'/397'/0'/0'/0'" ? "#1a3a5c" : "#2c2c2c"}; color: #fff; font-size: 13px; text-align: left; cursor: pointer; box-sizing: border-box;"
            >
              <span style="font-weight: 500;">Account 1</span>
              <span style="color: #888; font-size: 11px; font-family: monospace; display: block; margin-top: 2px;">44'/397'/0'/0'/0'</span>
            </button>
            <button
              id="path1Btn"
              class="path-btn"
              data-path="44'/397'/0'/0'/1'"
              style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid ${currentPath === "44'/397'/0'/0'/1'" ? "#4c8bf5" : "#444"};
                     background: ${currentPath === "44'/397'/0'/0'/1'" ? "#1a3a5c" : "#2c2c2c"}; color: #fff; font-size: 13px; text-align: left; cursor: pointer; box-sizing: border-box;"
            >
              <span style="font-weight: 500;">Account 2</span>
              <span style="color: #888; font-size: 11px; font-family: monospace; display: block; margin-top: 2px;">44'/397'/0'/0'/1'</span>
            </button>
            <button
              id="path2Btn"
              class="path-btn"
              data-path="44'/397'/0'/0'/2'"
              style="width: 100%; padding: 10px; border-radius: 8px; border: 1px solid ${currentPath === "44'/397'/0'/0'/2'" ? "#4c8bf5" : "#444"};
                     background: ${currentPath === "44'/397'/0'/0'/2'" ? "#1a3a5c" : "#2c2c2c"}; color: #fff; font-size: 13px; text-align: left; cursor: pointer; box-sizing: border-box;"
            >
              <span style="font-weight: 500;">Account 3</span>
              <span style="color: #888; font-size: 11px; font-family: monospace; display: block; margin-top: 2px;">44'/397'/0'/0'/2'</span>
            </button>
          </div>
          <div style="margin-bottom: 12px;">
            <button
              id="toggleCustomBtn"
              style="background: transparent; border: none; color: #888; font-size: 12px; cursor: pointer; padding: 0; text-decoration: underline;"
            >
              ${showCustom ? "Hide" : "Use"} custom path
            </button>
            ${
                showCustom
                    ? `
            <div style="margin-top: 10px;">
              <input
                type="text"
                id="customPathInput"
                value="${currentPath}"
                placeholder="44'/397'/0'/0'/0'"
                style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #444;
                       background: #2c2c2c; color: #fff; font-size: 12px; font-family: monospace; box-sizing: border-box;"
              />
            </div>
            `
                    : ""
            }
          </div>
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button id="cancelBtn" style="background: #444;">Cancel</button>
            <button id="confirmBtn" style="background: #4c8bf5;">Continue</button>
          </div>
        </div>
      `;
    }

    renderUI();

    return new Promise((resolve, reject) => {
        function setupListeners() {
            const confirmBtn = document.getElementById("confirmBtn");
            const cancelBtn = document.getElementById("cancelBtn");
            const toggleCustomBtn = document.getElementById("toggleCustomBtn");
            const customPathInput = document.getElementById("customPathInput");
            const pathBtns = document.querySelectorAll(".path-btn");

            // Handle path button clicks
            pathBtns.forEach((btn) => {
                btn.addEventListener("click", () => {
                    currentPath = btn.dataset.path;
                    renderUI();
                    setupListeners();
                });
            });

            // Handle toggle custom path
            toggleCustomBtn.addEventListener("click", () => {
                showCustom = !showCustom;
                renderUI();
                setupListeners();
            });

            confirmBtn.addEventListener("click", () => {
                const finalPath =
                    showCustom && customPathInput
                        ? customPathInput.value.trim() || currentPath
                        : currentPath;
                root.innerHTML = "";
                root.style.display = "none";
                // Don't hide iframe - let next UI take over
                resolve(finalPath);
            });

            cancelBtn.addEventListener("click", () => {
                root.innerHTML = "";
                root.style.display = "none";
                window.selector.ui.hideIframe();
                reject(new Error("User cancelled"));
            });
        }

        setupListeners();
    });
}

/**
 * Helper function to show a waiting/approval UI
 * @param {string} title - Title to display
 * @param {string} message - Message to display
 * @param {Function} asyncOperation - Async operation to perform
 * @param {boolean} hideOnSuccess - Whether to hide iframe on success (default: false to allow smooth transition to next UI)
 * @returns {Promise} - Result of the async operation
 */
async function showLedgerApprovalUI(
    title,
    message,
    asyncOperation,
    hideOnSuccess = false,
) {
    await window.selector.ui.showIframe();

    const root = document.getElementById("root");
    root.style.display = "flex";

    root.innerHTML = `
    <div class="prompt-container" style="max-width: 400px; padding: 24px; text-align: center;">
      <div style="font-size: 48px; margin-bottom: 16px;">🔐</div>
      <h1 style="margin-bottom: 16px;">${title}</h1>
      <p style="margin-bottom: 24px; color: #aaa;">${message}</p>
      <div style="display: flex; justify-content: center;">
        <div style="width: 24px; height: 24px; border: 3px solid #444; border-top-color: #4c8bf5; border-radius: 50%; animation: spin 1s linear infinite;"></div>
      </div>
      <style>
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      </style>
    </div>
  `;

    try {
        const result = await asyncOperation();
        if (hideOnSuccess) {
            root.innerHTML = "";
            root.style.display = "none";
            window.selector.ui.hideIframe();
        }
        // Don't hide on success - let the next UI take over smoothly
        return result;
    } catch (error) {
        root.innerHTML = "";
        root.style.display = "none";
        window.selector.ui.hideIframe();
        throw error;
    }
}

/**
 * Helper function to show account ID input dialog
 * @param {string} implicitAccountId - Optional implicit account ID for the button
 * @param {Function} onVerify - Optional async function to verify the account (receives accountId, returns true or throws)
 */
async function promptForAccountId(implicitAccountId = "", onVerify = null) {
    await window.selector.ui.showIframe();

    const root = document.getElementById("root");
    root.style.display = "flex";

    function renderUI(errorMessage = null, currentValue = "") {
        root.innerHTML = `
        <div class="prompt-container" style="max-width: 400px; padding: 24px;">
          <h1 style="margin-bottom: 16px;">Enter Account ID</h1>
          <p style="margin-bottom: 16px; color: #aaa;">
            Ledger provides your public key. Please enter the NEAR account ID
            that this key has full access to.
          </p>
          ${
              errorMessage
                  ? `
          <div style="background: #3d2020; border: 1px solid #5c3030; border-radius: 8px; padding: 12px; margin-bottom: 12px; text-align: left;">
            <p style="color: #ff8080; font-size: 13px; margin: 0;">${errorMessage}</p>
          </div>
          `
                  : ""
          }
          <input
            type="text"
            id="accountIdInput"
            placeholder="example.near"
            value="${currentValue}"
            style="width: 100%; padding: 12px; border-radius: 8px; border: 1px solid ${errorMessage ? "#5c3030" : "#444"};
                   background: #2c2c2c; color: #fff; font-size: 14px; margin-bottom: 8px;"
          />
          ${
              implicitAccountId
                  ? `
          <button
            id="useImplicitBtn"
            style="width: 100%; padding: 8px; border-radius: 6px; border: 1px solid #555;
                   background: transparent; color: #aaa; font-size: 12px; margin-bottom: 16px;
                   cursor: pointer; text-align: left;"
          >
            Use implicit account: <span style="color: #4c8bf5; font-family: monospace;">${implicitAccountId.slice(0, 12)}...${implicitAccountId.slice(-8)}</span>
          </button>
          `
                  : ""
          }
          <div style="display: flex; gap: 8px; justify-content: flex-end;">
            <button id="cancelBtn" style="background: #444;">Cancel</button>
            <button id="confirmBtn" style="background: #4c8bf5;">Confirm</button>
          </div>
        </div>
      `;
    }

    renderUI();

    return new Promise((resolve, reject) => {
        function setupListeners() {
            const input = document.getElementById("accountIdInput");
            const confirmBtn = document.getElementById("confirmBtn");
            const cancelBtn = document.getElementById("cancelBtn");
            const useImplicitBtn = document.getElementById("useImplicitBtn");

            // Handle "Use implicit account" button click
            if (useImplicitBtn && implicitAccountId) {
                useImplicitBtn.addEventListener("click", () => {
                    input.value = implicitAccountId;
                    input.focus();
                });
            }

            confirmBtn.addEventListener("click", async () => {
                const accountId = input.value.trim();
                if (!accountId) return;

                // If verification function provided, verify first
                if (onVerify) {
                    confirmBtn.disabled = true;
                    confirmBtn.textContent = "Verifying...";

                    try {
                        await onVerify(accountId);
                        root.innerHTML = "";
                        root.style.display = "none";
                        window.selector.ui.hideIframe();
                        resolve(accountId);
                    } catch (error) {
                        // Show error and allow retry
                        renderUI(error.message, accountId);
                        setupListeners();
                    }
                } else {
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
        }

        setupListeners();
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
            throw new Error(
                "The public key does not have FullAccess permission for this account",
            );
        }

        return true;
    } catch (error) {
        if (error.message.includes("does not exist")) {
            throw new Error(
                `Access key not found for account ${accountId}. Please make sure the account exists and has the Ledger public key registered.`,
            );
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
    }

    async getDerivationPath() {
        const derivationPath = await window.selector.storage.get(
            STORAGE_KEY_DERIVATION_PATH,
        );
        return derivationPath || DEFAULT_DERIVATION_PATH;
    }

    /**
     * Sign in with Ledger device
     */
    async signIn(params) {
        try {
            // Prompt user to connect Ledger (provides user gesture for WebHID)
            await promptForLedgerConnect(this.ledger);

            // Let user select derivation path
            const defaultDerivationPath = await this.getDerivationPath();
            const derivationPath = await promptForDerivationPath(
                defaultDerivationPath,
            );

            // Get public key from Ledger (requires user approval on device)
            const publicKeyString = await showLedgerApprovalUI(
                "Approve on Ledger",
                "Please approve the request on your Ledger device to share your public key.",
                () => this.ledger.getPublicKey(derivationPath),
            );
            const publicKey = `ed25519:${publicKeyString}`;

            // Calculate implicit account ID (hex-encoded public key bytes)
            const publicKeyBytes = baseDecode(publicKeyString);
            const implicitAccountId =
                Buffer.from(publicKeyBytes).toString("hex");

            console.log(publicKey);
            // Verification function to check account access
            const network = params?.network || "mainnet";
            const verifyAccount = async (accountId) => {
                await verifyAccessKey(network, accountId, publicKey);
            };

            // Prompt user for account ID with inline verification
            const accountId = await promptForAccountId(
                implicitAccountId,
                verifyAccount,
            );

            // Store the account information
            const accounts = [{ accountId, publicKey }];
            await window.selector.storage.set(
                STORAGE_KEY_ACCOUNTS,
                JSON.stringify(accounts),
            );
            await window.selector.storage.set(
                STORAGE_KEY_DERIVATION_PATH,
                derivationPath,
            );

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
        const accountsJson =
            await window.selector.storage.get(STORAGE_KEY_ACCOUNTS);
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
                    BigInt(action.params.deposit || "0"),
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
                            BigInt(accessKey.permission.allowance || "0"),
                        ),
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
            blockHash,
        );

        // Serialize and sign with Ledger (requires user approval on device)
        const serializedTx = encodeTransaction(transaction);
        const derivationPath = await this.getDerivationPath();
        const signature = await showLedgerApprovalUI(
            "Approve Transaction",
            "Please review and approve the transaction on your Ledger device.",
            () => this.ledger.sign(serializedTx, derivationPath),
            true, // Hide on success since we're done with UI
        );

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
        const result = await rpcRequest(network, "broadcast_tx_commit", [
            base64Tx,
        ]);

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
            4 +
            messageBytes.length + // message (length + data)
            32 + // nonce (fixed 32 bytes)
            4 +
            recipientBytes.length + // recipient (length + data)
            1; // callback_url (0 = None)

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

        // Sign with Ledger (requires user approval on device)
        const derivationPath = await this.getDerivationPath();
        const signature = await showLedgerApprovalUI(
            "Sign Message",
            "Please review and approve the message signing on your Ledger device.",
            () => this.ledger.signMessage(payload, derivationPath),
            true, // Hide on success since we're done with UI
        );

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
