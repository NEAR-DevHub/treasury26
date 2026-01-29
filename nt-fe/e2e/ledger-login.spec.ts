import { test, expect } from "@playwright/test";

test("Ledger login flow", async ({ page }) => {
  // Navigate to the app
  await page.goto("/app");

  // Click Connect Wallet button
  await page.getByRole("button", { name: /connect wallet/i }).click();

  // Verify wallet selector appears
  await expect(page.getByText("Select wallet")).toBeVisible();

  // Verify Ledger option is visible and click it
  const ledgerOption = page.getByText("Ledger", { exact: true });
  await expect(ledgerOption).toBeVisible();
  await ledgerOption.click();

  // The Ledger flow runs in a sandboxed iframe
  // Wait for the Connect Ledger prompt or account input to appear
  await page.waitForTimeout(2000);

  // Note: Full flow requires actual hardware device
  // This test verifies the UI flow up to device connection
});
