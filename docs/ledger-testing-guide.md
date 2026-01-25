# Ledger Wallet Testing Guide

## Prerequisites

1. **Hardware**:
   - Ledger Nano S, Nano S Plus, or Nano X device
   - USB cable to connect to computer

2. **Software**:
   - Ledger Live app installed
   - NEAR app installed on Ledger device (via Ledger Live)
   - Supported browser: Chrome, Edge, or Opera (desktop)

3. **Account Setup**:
   - NEAR account with Ledger public key registered as FullAccess key
   - Account funded with NEAR tokens for gas fees

## Step-by-Step Testing

### 1. Verify Browser Compatibility

**Test**: Open Treasury26 in different browsers

**Expected**:
- Chrome/Edge/Opera (desktop): Ledger option appears in wallet selector
- Firefox/Safari/Mobile browsers: Ledger option does NOT appear

**How to verify**:
1. Open browser console (F12)
2. Look for: "Ledger wallet registered successfully"
3. Or warning: "Failed to register Ledger wallet" (on unsupported browsers)

### 2. Test Sign-In Flow

**Test**: Connect Ledger wallet

**Steps**:
1. Click "Connect Wallet" button
2. Select "Ledger" from wallet options
3. Connect and unlock Ledger device
4. Open NEAR app on Ledger device
5. Browser shows permission dialog - click "Connect"
6. Enter your NEAR account ID when prompted
7. Confirm on Ledger device when prompted for public key

**Expected**:
- Account ID input dialog appears
- Access key verification succeeds
- Wallet connects successfully
- Account ID displayed in UI

**Common issues**:
- "Device not found" → Ensure Ledger is connected and unlocked
- "NEAR app not open" → Open NEAR app on device
- "Access key not found" → Verify Ledger public key is registered on account

### 3. Test Transaction Signing

**Test**: Create a proposal or vote

**Steps**:
1. Navigate to a treasury
2. Create a proposal or vote on existing proposal
3. Review transaction details
4. Confirm action in UI
5. Ledger device shows transaction details
6. Approve transaction on Ledger device

**Expected**:
- Transaction details displayed on Ledger screen
- Transaction broadcasts after device approval
- Success message shown in UI
- Proposal/vote appears in dashboard

**Common issues**:
- "User rejected" → Transaction was rejected on device
- "Transaction failed" → Check account has sufficient balance
- Timeout → Ledger interaction took too long (>60s)

### 4. Test Message Signing (NEP-413)

**Test**: Sign a message

**Steps**:
1. Trigger any action requiring message signing
2. Review message details
3. Approve on Ledger device

**Expected**:
- Message displayed on Ledger screen
- Signature returned after device approval

### 5. Test Sign-Out

**Test**: Disconnect wallet

**Steps**:
1. Click disconnect/sign-out
2. Verify wallet disconnects

**Expected**:
- Account ID removed from UI
- Stored data cleared
- Ledger disconnects

## Security Tests

### Test 1: Malicious Account Entry
**Test**: Enter wrong account ID during sign-in
**Expected**: Access key verification fails with clear error message

### Test 2: Device Disconnection
**Test**: Disconnect Ledger during transaction signing
**Expected**: Transaction fails gracefully with error message

### Test 3: User Rejection
**Test**: Reject transaction on Ledger device
**Expected**: Transaction cancelled, clear error message shown

## Performance Tests

### Test 1: Large Transactions
**Test**: Sign transaction with many actions
**Expected**: Chunking works correctly, all actions signed

### Test 2: Multiple Consecutive Transactions
**Test**: Sign multiple transactions in sequence
**Expected**: Each transaction signed successfully without device reset needed

## Browser Console Testing

Open browser console (F12) and check for:

### Expected Messages
```
✅ "Ledger wallet registered successfully"
✅ "Ledger connected"
✅ "Transaction signed successfully"
```

### Warning Messages (expected on unsupported browsers)
```
⚠️ "Failed to register Ledger wallet: WebHID not supported"
```

### Error Messages (investigate if seen)
```
❌ "Device not connected"
❌ "Access key verification failed"
❌ "Transaction signing failed"
```

## Automated Testing Checklist

- [ ] Browser compatibility check
- [ ] Wallet registration on supported browsers
- [ ] Sign-in flow with valid account
- [ ] Sign-in flow with invalid account
- [ ] Single transaction signing
- [ ] Multiple transactions signing
- [ ] Message signing (NEP-413)
- [ ] Sign-out flow
- [ ] Device disconnection handling
- [ ] User rejection handling
- [ ] Large transaction chunking

## Reporting Issues

When reporting issues, include:
1. Browser and version
2. Ledger device model and firmware version
3. NEAR app version on Ledger
4. Steps to reproduce
5. Browser console logs
6. Expected vs actual behavior

## Additional Resources

- [Ledger NEAR App Setup](https://support.ledger.com/hc/en-us/articles/360019868977)
- [WebHID Browser Support](https://caniuse.com/webhid)
- [Treasury26 Ledger Documentation](../docs/ledger-wallet-support.md)
