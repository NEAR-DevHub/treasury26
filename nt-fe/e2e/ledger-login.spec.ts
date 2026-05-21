import { test, expect } from "@playwright/test";

// Mock WebHID API and Ledger device responses - this gets prepended to ledger-executor.js
const mockWebHID = `
// ===== MOCK WEBHID FOR TESTING =====
(function() {
  // APDU response codes
  const SW_OK = 0x9000;
  
  // Mock NEAR Ledger app responses - ed25519 public key (32 bytes)
  // This is the sandbox genesis public key for test.near
  // ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB
  const MOCK_PUBLIC_KEY = new Uint8Array([
    62, 16, 3, 217, 88, 51, 205, 129,
    209, 254, 126, 182, 139, 157, 10, 82,
    180, 98, 156, 71, 69, 33, 32, 49,
    247, 112, 81, 86, 48, 15, 60, 250
  ]);

  // Ledger HID framing constants
  const TAG_APDU = 0x05;

  // Store the channel from incoming requests to echo back
  let currentChannel = 0x0101;

  class MockHIDDevice extends EventTarget {
    constructor() {
      super();
      this.opened = false;
      this.oninputreport = null;
      this.productName = "Nano S";
      this.vendorId = 0x2c97;
      this.productId = 0x0001;
      this.collections = [{ usage: 0xf1d0, usagePage: 0xffa0 }];
    }

    async open() {
      this.opened = true;
      console.log('[Mock Ledger] Device opened');
    }

    async close() {
      this.opened = false;
      console.log('[Mock Ledger] Device closed');
    }

    async sendReport(reportId, data) {
      const dataArray = new Uint8Array(data);
      console.log('[Mock Ledger] sendReport, first bytes:', Array.from(dataArray.slice(0, 10)));
      
      // Parse Ledger HID frame to extract APDU
      // Format: channel (2) + tag (1) + sequence (2) + [length (2) on first packet] + data
      currentChannel = (dataArray[0] << 8) | dataArray[1];  // Save channel to echo back
      const tag = dataArray[2];
      const seq = (dataArray[3] << 8) | dataArray[4];
      
      if (seq === 0) {
        // First packet - has length
        const apduLength = (dataArray[5] << 8) | dataArray[6];
        const apdu = dataArray.slice(7, 7 + Math.min(apduLength, dataArray.length - 7));
        
        console.log('[Mock Ledger] APDU:', Array.from(apdu.slice(0, 5)));
        
        // Parse APDU: CLA INS P1 P2 [Lc] [Data] [Le]
        const cla = apdu[0];
        const ins = apdu[1];
        
        let responseData;
        
        if (cla === 0xB0) { // Standard Ledger dashboard commands
          switch (ins) {
            case 0x01: // GET_APP_AND_VERSION
              console.log('[Mock Ledger] GET_APP_AND_VERSION');
              // Response: format(1) + name_len(1) + name + version_len(1) + version + flags(1) + SW_OK
              const appName = [0x4E, 0x45, 0x41, 0x52]; // "NEAR"
              const version = [0x31, 0x2E, 0x30, 0x2E, 0x30]; // "1.0.0"
              responseData = new Uint8Array([
                0x01,            // format
                appName.length,  // app name length
                ...appName,      // app name bytes
                version.length,  // version length
                ...version,      // version bytes
                0x00,            // flags
                0x90, 0x00       // SW_OK
              ]);
              break;
            default:
              console.log('[Mock Ledger] Unknown dashboard INS:', ins.toString(16));
              responseData = new Uint8Array([0x6D, 0x00]); // SW_INS_NOT_SUPPORTED
          }
        } else if (cla === 0x80) { // NEAR app
          switch (ins) {
            case 0x04: // GET_PUBLIC_KEY
              console.log('[Mock Ledger] GET_PUBLIC_KEY');
              responseData = new Uint8Array([...MOCK_PUBLIC_KEY, 0x90, 0x00]);
              break;
            case 0x02: // SIGN_TRANSACTION
            case 0x07: // SIGN_MESSAGE (NEP-413)
              console.log('[Mock Ledger]', ins === 0x02 ? 'SIGN_TRANSACTION' : 'SIGN_MESSAGE');
              const mockSignature = new Uint8Array(64).fill(0xAB);
              responseData = new Uint8Array([...mockSignature, 0x90, 0x00]);
              break;
            case 0x06: // GET_VERSION
              console.log('[Mock Ledger] GET_VERSION');
              responseData = new Uint8Array([1, 0, 0, 0x90, 0x00]); // Version 1.0.0
              break;
            default:
              console.log('[Mock Ledger] Unknown INS:', ins.toString(16));
              responseData = new Uint8Array([0x6D, 0x00]); // SW_INS_NOT_SUPPORTED
          }
        } else {
          console.log('[Mock Ledger] Unknown CLA:', cla.toString(16));
          responseData = new Uint8Array([0x6E, 0x00]); // SW_CLA_NOT_SUPPORTED
        }
        
        // Send response after realistic delay (real Ledger devices take 500ms-2s)
        // Using 500ms to avoid race condition with wallet selector's iframe hide/show transitions
        setTimeout(() => this._sendResponse(responseData), 500);
      }
    }

    _sendResponse(data) {
      // Build Ledger HID response frames.
      // First frame: channel(2) + tag(1) + seq(2) + length(2) + data (max 57 bytes)
      // Continuation frames: channel(2) + tag(1) + seq(2) + data (max 59 bytes)
      const responseLength = data.length;
      console.log('[Mock Ledger] Sending response, length:', responseLength);

      let offset = 0;
      let seq = 0;

      const sendFrame = () => {
        const packet = new Uint8Array(64);
        packet[0] = (currentChannel >> 8) & 0xff;
        packet[1] = currentChannel & 0xff;
        packet[2] = TAG_APDU;
        packet[3] = (seq >> 8) & 0xff;
        packet[4] = seq & 0xff;

        let headerSize;
        if (seq === 0) {
          // First frame includes the total response length
          packet[5] = (responseLength >> 8) & 0xff;
          packet[6] = responseLength & 0xff;
          headerSize = 7;
        } else {
          headerSize = 5;
        }

        const maxData = 64 - headerSize;
        const chunk = data.slice(offset, offset + maxData);
        packet.set(chunk, headerSize);
        offset += chunk.length;
        seq++;

        const event = new Event('inputreport');
        event.device = this;
        event.reportId = 0;
        event.data = new DataView(packet.buffer);

        if (this.oninputreport) {
          this.oninputreport(event);
        }
        this.dispatchEvent(event);

        // Send continuation frames if there's more data
        if (offset < responseLength) {
          setTimeout(sendFrame, 10);
        }
      };

      sendFrame();
    }
  }

  // Create mock device
  const mockDevice = new MockHIDDevice();
  
  // Override navigator.hid
  Object.defineProperty(navigator, 'hid', {
    value: {
      getDevices: async () => {
        // Return empty array so the "Connect Ledger" button appears
        // (simulates no pre-authorized devices)
        console.log('[Mock HID] getDevices - returning empty (no pre-authorized devices)');
        return [];
      },
      requestDevice: async (options) => {
        // This is called when user clicks "Connect Ledger" button
        console.log('[Mock HID] requestDevice - returning mock device');
        return [mockDevice];
      },
      addEventListener: (event, handler) => {},
      removeEventListener: (event, handler) => {}
    },
    writable: false,
    configurable: true
  });

  console.log('[Mock HID] WebHID API mocked in iframe context!');
})();
// ===== END MOCK =====

`;

test("Ledger login flow", async ({ page, context }) => {
    // Increase timeout for this test due to pauses for video recording
    test.setTimeout(120000);
    // Capture console logs from the iframe
    const logs: string[] = [];
    page.on("console", (msg) => {
        const text = msg.text();
        logs.push(text);
        if (text.includes("[Mock")) {
            console.log("MOCK LOG:", text);
        }
    });

    // Capture page errors
    page.on("pageerror", (error) => {
        console.log("PAGE ERROR:", error.message);
    });

    // Capture ALL console messages including errors and warnings
    page.on("console", (msg) => {
        if (msg.type() === "error") {
            console.log("CONSOLE ERROR:", msg.text());
        } else if (msg.type() === "warning") {
            console.log("CONSOLE WARN:", msg.text());
        }
    });

    // Also log all console messages to help debug
    page.on("console", (msg) => {
        const text = msg.text();
        // Log messages that might indicate the flow state
        if (
            text.includes("Ledger") ||
            text.includes("account") ||
            text.includes("error") ||
            text.includes("Error")
        ) {
            console.log(`CONSOLE [${msg.type()}]:`, text);
        }
    });

    // Inject WebHID mock into all frames BEFORE any JavaScript runs
    // This is critical because TransportWebHID from the CDN will access navigator.hid
    await context.addInitScript(mockWebHID);

    // Intercept RPC calls and return mock responses.
    // The ledger-executor.js calls rpc.near.org (mainnet) for access key verification.
    await context.route(
        /rpc\.(mainnet|testnet)?\.?(fastnear\.com|near\.org)/,
        async (route) => {
            const request = route.request();
            const postData = request.postData();
            const body = postData ? JSON.parse(postData) : {};

            console.log("Intercepting NEAR RPC:", body.method);

            let result;
            if (body.method === "query") {
                const requestType = body.params?.request_type;
                if (requestType === "view_access_key") {
                    // Return a full access key for the mock public key
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            block_hash: "A".repeat(44),
                            block_height: 100000000,
                            nonce: 1,
                            permission: "FullAccess",
                        },
                    };
                } else if (requestType === "view_access_key_list") {
                    // Return a list containing the mock public key
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            block_hash: "A".repeat(44),
                            block_height: 100000000,
                            keys: [
                                {
                                    public_key:
                                        "ed25519:5BGSaf6YjVm7565VzWQHNxoyEjwr3jUpRJSGjREvU9dB",
                                    access_key: {
                                        nonce: 1,
                                        permission: "FullAccess",
                                    },
                                },
                            ],
                        },
                    };
                } else if (requestType === "view_account") {
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {
                            amount: "1000000000000000000000000",
                            locked: "0",
                            code_hash: "11111111111111111111111111111111",
                            storage_usage: 182,
                            storage_paid_at: 0,
                            block_height: 100000000,
                            block_hash: "A".repeat(44),
                        },
                    };
                } else {
                    // Generic success for other query types
                    result = {
                        jsonrpc: "2.0",
                        id: body.id,
                        result: {},
                    };
                }
            } else {
                // Generic success for non-query methods
                result = {
                    jsonrpc: "2.0",
                    id: body.id,
                    result: {},
                };
            }

            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify(result),
            });
        },
    );

    // Mock backend auth endpoints since the sandbox doesn't have full auth support.
    // IMPORTANT: /api/auth/me must return 401 (unauthenticated) until the login
    // flow completes, otherwise the app thinks the user is already logged in and
    // redirects away from the welcome page before we can click "Connect Wallet".
    let isLoggedIn = false;

    await context.route("**/api/auth/challenge", async (route) => {
        console.log("Mocking auth challenge endpoint");
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({ nonce: "dGVzdC1ub25jZS0xMjM0NTY3ODkw" }), // Base64 encoded test nonce
        });
    });

    await context.route("**/api/auth/login", async (route) => {
        console.log("Mocking auth login endpoint");
        isLoggedIn = true;
        await route.fulfill({
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
                accountId: "test.near",
                termsAccepted: true, // Simulate terms already accepted
            }),
        });
    });

    await context.route("**/api/auth/me", async (route) => {
        if (isLoggedIn) {
            console.log("Mocking auth me endpoint (authenticated)");
            await route.fulfill({
                status: 200,
                contentType: "application/json",
                body: JSON.stringify({
                    accountId: "test.near",
                    termsAccepted: true,
                }),
            });
        } else {
            console.log("Mocking auth me endpoint (not yet authenticated)");
            await route.fulfill({
                status: 401,
                contentType: "application/json",
                body: JSON.stringify({ error: "Not authenticated" }),
            });
        }
    });

    // Navigate to the app
    await page.goto("/");
    await page.waitForTimeout(1500); // Pause to show the initial page

    // Click existing-user onboarding option (this now routes to /login page)
    await page.getByRole("button", { name: /i already use trezu/i }).click();
    await page.waitForTimeout(1000); // Pause to show the button

    // Verify we are on the dedicated wallet connection page.
    await expect(page).toHaveURL(/\/login\?context=existing_user$/);
    await page.waitForTimeout(1500); // Pause to show wallet connection page

    // Verify Ledger option is visible in available options and click it
    const ledgerOption = page.getByRole("button", { name: "Ledger" });
    await expect(ledgerOption).toBeVisible();
    await ledgerOption.click();
    await page.waitForTimeout(1500);

    // Wait for the iframe to load
    const iframe = page
        .frameLocator('iframe[sandbox*="allow-scripts"]')
        .first();

    // The Ledger executor now auto-triggers device connection on load:
    //   requestDevice() → mock returns device → GET_APP_AND_VERSION → "Select Derivation Path"
    // No "Connect Ledger" button click is needed.

    // Handle the "Select Derivation Path" dialog - click Continue with default selection
    const continueBtn = iframe.getByRole("button", { name: /continue/i });
    await expect(continueBtn).toBeVisible({ timeout: 10000 });
    console.log(
        "Derivation path dialog visible, clicking Continue with default selection",
    );
    await page.waitForTimeout(1500); // Pause to show the derivation path dialog
    await continueBtn.click();
    console.log("Clicked Continue on derivation path dialog");
    await page.waitForTimeout(2000); // Pause for GET_PUBLIC_KEY mock response

    // Wait for account ID input to appear
    const accountIdInput = iframe.getByPlaceholder("example.near");
    await expect(accountIdInput).toBeVisible({ timeout: 10000 });
    console.log("Account ID input is visible");
    await page.waitForTimeout(1000); // Pause to show the dialog

    // Type the account ID with visible keystrokes
    await accountIdInput.click();
    await accountIdInput.pressSequentially("test.near", { delay: 150 });
    console.log("Typed account ID: test.near");
    await page.waitForTimeout(1500); // Pause to show the completed text

    // Click the confirm button
    const confirmBtn = iframe.getByRole("button", { name: /confirm/i });
    await confirmBtn.click();
    console.log("Clicked confirm button");

    // Verify the mock was used by checking logs
    const mockWasUsed = logs.some(
        (log) => log.includes("[Mock HID]") || log.includes("[Mock Ledger]"),
    );
    console.log("Mock was used:", mockWasUsed);
    console.log(
        "Relevant logs:",
        logs.filter((l) => l.includes("[Mock")),
    );

    // Wait for login to complete
    await page.waitForTimeout(2000);

    // Verify login succeeded - should redirect away from the login page
    // to either /app/new (no treasury) or /{treasuryId} (has treasury in sandbox)
    await expect(page).not.toHaveURL("/", {
        timeout: 10000,
    });
    console.log("Login successful - redirected to:", page.url());

    // Pause at the end to clearly show the successful login result
    await page.waitForTimeout(3000);
});
