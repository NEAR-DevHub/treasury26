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
        
        if (cla === 0x80) { // NEAR app
          switch (ins) {
            case 0x04: // GET_PUBLIC_KEY
              console.log('[Mock Ledger] GET_PUBLIC_KEY');
              responseData = new Uint8Array([...MOCK_PUBLIC_KEY, 0x90, 0x00]);
              break;
            case 0x02: // SIGN_TRANSACTION
              console.log('[Mock Ledger] SIGN_TRANSACTION');
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
          responseData = new Uint8Array([0x6E, 0x00]); // SW_CLA_NOT_SUPPORTED
        }
        
        // Send response after small delay (simulating device processing)
        setTimeout(() => this._sendResponse(responseData), 10);
      }
    }

    _sendResponse(data) {
      // Build Ledger HID response frame
      const responseLength = data.length;
      const packet = new Uint8Array(64);

      // Channel - echo back the same channel from the request
      packet[0] = (currentChannel >> 8) & 0xff;
      packet[1] = currentChannel & 0xff;
      // Tag
      packet[2] = TAG_APDU;
      // Sequence (0 for first packet)
      packet[3] = 0;
      packet[4] = 0;
      // Length
      packet[5] = (responseLength >> 8) & 0xff;
      packet[6] = responseLength & 0xff;
      // Data
      packet.set(data.slice(0, Math.min(data.length, 57)), 7);
      
      console.log('[Mock Ledger] Sending response, length:', responseLength);

      // Dispatch input report event using proper HIDInputReportEvent structure
      const event = new Event('inputreport');
      event.device = this;
      event.reportId = 0;
      event.data = new DataView(packet.buffer);

      // Try both methods - property handler and event dispatch
      if (this.oninputreport) {
        this.oninputreport(event);
      }
      this.dispatchEvent(event);
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
  // Capture console logs from the iframe
  const logs: string[] = [];
  page.on('console', msg => {
    const text = msg.text();
    logs.push(text);
    if (text.includes('[Mock')) {
      console.log('MOCK LOG:', text);
    }
  });

  // Capture page errors
  page.on('pageerror', error => {
    console.log('PAGE ERROR:', error.message);
  });

  // Capture ALL console messages including errors and warnings
  page.on('console', msg => {
    if (msg.type() === 'error') {
      console.log('CONSOLE ERROR:', msg.text());
    } else if (msg.type() === 'warning') {
      console.log('CONSOLE WARN:', msg.text());
    }
  });

  // Also log all console messages to help debug
  page.on('console', msg => {
    const text = msg.text();
    // Log messages that might indicate the flow state
    if (text.includes('Ledger') || text.includes('account') || text.includes('error') || text.includes('Error')) {
      console.log(`CONSOLE [${msg.type()}]:`, text);
    }
  });

  // Inject WebHID mock into all frames BEFORE any JavaScript runs
  // This is critical because TransportWebHID from the CDN will access navigator.hid
  await context.addInitScript(mockWebHID);

  // Intercept RPC calls to FastNEAR and redirect to local sandbox
  // The ledger-executor.js calls mainnet RPC for access key verification
  await context.route('**/rpc.*.fastnear.com/**', async (route) => {
    const request = route.request();
    const postData = request.postData();

    console.log('Intercepting FastNEAR RPC, redirecting to sandbox');

    // Forward the request to local sandbox
    const response = await fetch('http://localhost:3030', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: postData,
    });

    const body = await response.text();
    await route.fulfill({
      status: response.status,
      contentType: 'application/json',
      body,
    });
  });

  // Navigate to the app
  await page.goto("/app");
  await page.waitForTimeout(1500); // Pause to show the initial page

  // Click Connect Wallet button
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.waitForTimeout(1000); // Pause to show the button

  // Verify wallet selector appears
  await expect(page.getByText("Select wallet")).toBeVisible();
  await page.waitForTimeout(1500); // Pause to show the wallet selector modal

  // Verify Ledger option is visible and click it
  const ledgerOption = page.getByText("Ledger", { exact: true });
  await expect(ledgerOption).toBeVisible();
  await page.waitForTimeout(1000); // Pause before clicking Ledger
  await ledgerOption.click();
  await page.waitForTimeout(1500); // Pause to show Ledger iframe loading

  // Wait for the iframe to load
  const iframe = page.frameLocator('iframe[sandbox*="allow-scripts"]').first();

  // Assert the "Connect Ledger" button appears (mock returns empty from getDevices)
  const connectLedgerButton = iframe.getByRole("button", { name: /connect ledger/i });
  await expect(connectLedgerButton).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(1500); // Pause to show the Connect Ledger button

  // Click the Connect Ledger button - the mock will handle requestDevice()
  // Wait a moment for the iframe to stabilize before clicking
  await page.waitForTimeout(500);
  console.log('About to click Connect Ledger button...');
  await connectLedgerButton.click();
  console.log('Clicked Connect Ledger button');
  await page.waitForTimeout(2000); // Pause to show the device connection happening

  // After clicking, the flow:
  // 1. Gets public key from Ledger (mock handles this)
  // 2. Hides iframe briefly
  // 3. Shows iframe again with account ID input prompt
  // Wait for the account ID input to appear and be visible
  const accountIdInput = iframe.getByPlaceholder("example.near");

  // The iframe is hidden after Connect Ledger, then re-shown for account ID input
  // Wait for the input to exist in the DOM
  await accountIdInput.waitFor({ state: 'attached', timeout: 30000 });
  console.log('Account ID input is attached to DOM');

  // The iframe is hidden by the parent app - force it to be visible for the video
  const iframeElement = page.locator('iframe[sandbox*="allow-scripts"]').first();
  await iframeElement.evaluate((el) => {
    (el as HTMLElement).style.cssText = 'display: block !important; visibility: visible !important; opacity: 1 !important; width: 400px !important; height: 300px !important; position: fixed !important; top: 50% !important; left: 50% !important; transform: translate(-50%, -50%) !important; z-index: 99999 !important; background: white !important; border: 2px solid #333 !important;';
  });

  // Get the frame handle for direct interaction
  const iframeHandle = await iframeElement.elementHandle();
  const frame = await iframeHandle?.contentFrame();

  if (!frame) {
    throw new Error('Could not get iframe frame');
  }

  // Make the input and button visible inside the iframe
  await frame.evaluate(() => {
    const input = document.getElementById('accountIdInput') as HTMLInputElement;
    const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement;
    const container = input?.parentElement;
    // Make everything visible
    if (container) {
      container.style.cssText = 'display: block !important; visibility: visible !important;';
    }
    if (input) {
      input.style.cssText = 'display: block !important; visibility: visible !important; width: 300px !important; padding: 10px !important; font-size: 16px !important;';
    }
    if (confirmBtn) {
      confirmBtn.style.cssText = 'display: block !important; visibility: visible !important; margin-top: 10px !important; padding: 10px 20px !important;';
    }
  });

  await page.waitForTimeout(1000); // Pause to show the empty input field

  // Type the account ID using keyboard after focusing (for visual effect in video)
  await frame.focus('#accountIdInput');
  await page.keyboard.type('test.near', { delay: 100 }); // 100ms delay between keystrokes
  console.log('Typed account ID: test.near');

  // Also set the value programmatically to ensure it's correctly set for JS
  await frame.evaluate(() => {
    const input = document.getElementById('accountIdInput') as HTMLInputElement;
    if (input) {
      input.value = 'test.near';
      // Dispatch input event to trigger any listeners
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  await page.waitForTimeout(1500); // Pause to show the account ID entered

  // Click the confirm button via evaluate (since it may still not be "clickable" by Playwright)
  await frame.evaluate(() => {
    const confirmBtn = document.getElementById('confirmBtn') as HTMLButtonElement;
    if (confirmBtn) {
      confirmBtn.click();
    }
  });
  console.log('Clicked confirm button');

  // Verify the mock was used by checking logs
  const mockWasUsed = logs.some(log => log.includes('[Mock HID]') || log.includes('[Mock Ledger]'));
  console.log('Mock was used:', mockWasUsed);
  console.log('Relevant logs:', logs.filter(l => l.includes('[Mock')));

  // Wait for the login to complete and redirect
  await page.waitForTimeout(2000);

  // Verify login succeeded - should be on the Create Treasury page or similar
  // The URL should have changed from /app to /app/new or similar
  await expect(page).toHaveURL(/\/app\/(new|dashboard|treasury)/, { timeout: 10000 });
  console.log('Login successful - redirected to:', page.url());

  // Pause at the end to clearly show the successful login result
  await page.waitForTimeout(3000);
});
