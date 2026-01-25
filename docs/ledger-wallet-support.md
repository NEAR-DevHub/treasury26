# Ledger Hardware Wallet Support

This document describes the Ledger hardware wallet integration for Treasury26.

## Overview

Ledger hardware wallet support has been added to Treasury26 using the `@hot-labs/near-connect` wallet connector framework. This provides secure transaction signing using Ledger devices while maintaining compatibility with the existing wallet infrastructure.

## Browser Requirements

### Supported Browsers
Ledger support requires the **WebHID API**, which is available in:
- **Chrome/Chromium** 89+ (desktop only)
- **Edge** 89+ (desktop only)
- **Opera** 75+ (desktop only)

### Requirements
- **HTTPS/Secure Context**: WebHID is only available in secure contexts (HTTPS or localhost)
- **Desktop Only**: Mobile browsers do not support WebHID
- **User Permission**: Users must grant permission to access the Ledger device via WebHID

### Not Supported
- Mobile browsers (iOS Safari, Chrome Mobile, etc.)
- Firefox (does not support WebHID as of 2025)
- Older browser versions

## Implementation Details

### Files Created

1. **`nt-fe/public/ledger-executor.js`** (16KB)
   - Self-contained JavaScript executor script
   - Uses CDN imports from esm.sh for dependencies
   - Implements APDU communication with Ledger device
   - Handles transaction signing and NEP-413 message signing

2. **`nt-fe/lib/ledger-manifest.ts`**
   - Wallet manifest configuration
   - Defines permissions (usb, hid, storage)
   - Specifies supported features and networks

3. **Modified `nt-fe/stores/near-store.ts`**
   - Registers Ledger wallet after connector initialization
   - Checks for WebHID support before registration

### Architecture

```
┌─────────────────┐
│  Treasury26 UI  │
└────────┬────────┘
         │
┌────────▼─────────────┐
│  @hot-labs/near-     │
│  connect (Wallet     │
│  Connector)          │
└────────┬─────────────┘
         │
┌────────▼─────────────┐
│  Sandboxed Executor  │
│  (ledger-executor.js)│
└────────┬─────────────┘
         │
┌────────▼─────────────┐
│  WebHID API          │
└────────┬─────────────┘
         │
┌────────▼─────────────┐
│  Ledger Device       │
└──────────────────────┘
```

## User Flow

### Sign In
1. User selects "Ledger" from wallet selector
2. Browser prompts for permission to access Ledger device
3. Executor connects to Ledger and retrieves public key
4. User is prompted to enter their NEAR account ID
5. Executor verifies the public key has full access to the account
6. Account is stored in sandboxed localStorage

### Sign Transaction
1. User initiates a transaction (e.g., create proposal, vote)
2. Executor fetches current nonce and block hash from RPC
3. Transaction is constructed using `@near-js/transactions`
4. Transaction is sent to Ledger for signing (user confirms on device)
5. Signed transaction is broadcast to NEAR network via RPC

### Sign Message (NEP-413)
1. User initiates message signing
2. Message is formatted according to NEP-413 specification
3. Message is sent to Ledger for signing (user confirms on device)
4. Signature is returned to the application

## Technical Details

### Ledger APDU Communication
- **CLA**: 0x80 (standard for Ledger)
- **Network ID**: 87 (ASCII 'W' for mainnet)
- **Chunk Size**: 250 bytes (for large transactions)
- **Derivation Path**: `44'/397'/0'/0'/1'` (default NEAR path)

### Supported Operations
- ✅ Sign In (with account verification)
- ✅ Sign Out
- ✅ Get Accounts
- ✅ Sign and Send Transaction
- ✅ Sign and Send Multiple Transactions
- ✅ Sign Message (NEP-413)
- ✅ Mainnet support
- ✅ Testnet support

### Action Types Supported
- FunctionCall
- Transfer
- AddKey (FullAccess and FunctionCall)
- DeleteKey
- CreateAccount
- DeleteAccount
- Stake
- DeployContract

## Security Considerations

1. **Sandboxed Execution**: The executor runs in a sandboxed iframe with restricted permissions
2. **User Confirmation**: All transactions require physical confirmation on the Ledger device
3. **Access Key Verification**: During sign-in, the executor verifies the public key has full access to the account
4. **No Private Keys**: Private keys never leave the Ledger device
5. **Secure Context**: WebHID only works in HTTPS contexts

## Testing

### Manual Testing Checklist
- [ ] Wallet appears in selector on supported browsers
- [ ] Wallet does not appear on unsupported browsers (mobile, Firefox)
- [ ] Sign-in flow works correctly
  - [ ] Device permission prompt appears
  - [ ] Public key is retrieved from device
  - [ ] Account ID input dialog appears
  - [ ] Access key verification succeeds
- [ ] Transaction signing works
  - [ ] User confirmation required on device
  - [ ] Transaction broadcasts successfully
- [ ] Message signing works (NEP-413)
- [ ] Sign-out clears stored data

### Browser Testing Matrix
| Browser | Version | Desktop | Mobile | Status |
|---------|---------|---------|--------|--------|
| Chrome  | 89+     | ✅      | ❌     | Supported |
| Edge    | 89+     | ✅      | ❌     | Supported |
| Opera   | 75+     | ✅      | ❌     | Supported |
| Firefox | Any     | ❌      | ❌     | Not supported (no WebHID) |
| Safari  | Any     | ❌      | ❌     | Not supported (no WebHID) |

## Troubleshooting

### "Ledger not appearing in wallet selector"
- **Check browser**: Ensure using Chrome/Edge/Opera on desktop
- **Check context**: Ensure site is HTTPS or localhost
- **Check console**: Look for registration errors

### "Device not found"
- **Check connection**: Ensure Ledger is connected via USB
- **Check app**: Ensure NEAR app is open on Ledger
- **Check permissions**: Browser may have denied WebHID permission

### "Access key verification failed"
- **Check account**: Ensure the account exists
- **Check key**: Ensure the Ledger public key is registered with the account
- **Check access**: Ensure the key has FullAccess permission

## References

- [WebHID API Documentation](https://developer.mozilla.org/en-US/docs/Web/API/WebHID_API)
- [NEAR Wallet Selector Ledger](https://github.com/near/wallet-selector/tree/main/packages/ledger)
- [hot-connect Documentation](https://github.com/azbang/near-connect)
- [NEP-413: Message Signing](https://github.com/near/NEPs/blob/master/neps/nep-0413.md)
- [Ledger NEAR App](https://github.com/LedgerHQ/app-near)

## Future Enhancements

Potential improvements for future releases:
- Support for custom derivation paths
- Multiple account management
- Ledger device detection and status display
- Improved error messages and user guidance
- Support for NEP-366 (delegate actions)
