"use client";

import { useMemo, useState, useEffect } from "react";
import { Button } from "@/components/button";
import { useToken, useTokenBalance } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { cn, formatBalance, formatCurrency } from "@/lib/utils";
import TokenSelect from "@/components/token-select";
import { LargeInput } from "@/components/large-input";
import { InputBlock } from "@/components/input-block";
import type { TreasuryAsset } from "@/lib/api";
import { validateNearAddress, isValidNearAddressFormat } from "@/lib/near-validation";

interface PaymentFormSectionProps {
  // Token and amount
  selectedToken: TreasuryAsset | null;
  amount: string;
  onAmountChange: (amount: string) => void;
  onTokenChange?: (token: TreasuryAsset) => void;
  
  // Recipient
  recipient: string;
  onRecipientChange: (recipient: string) => void;
  
  // Options
  tokenLocked?: boolean;
  showBalance?: boolean;
    
  // Actions
  saveButtonText: string;
  onSave: () => void;
}

export function PaymentFormSection({
  selectedToken,
  amount,
  onAmountChange,
  onTokenChange,
  recipient,
  onRecipientChange,
  tokenLocked = false,
  showBalance = true,
  saveButtonText,
  onSave,
}: PaymentFormSectionProps) {
  const { selectedTreasury } = useTreasury();
  const [recipientError, setRecipientError] = useState<string | undefined>();
  const [isValidating, setIsValidating] = useState(false);

  const { data: tokenBalanceData, isLoading: isBalanceLoading } = useTokenBalance(
    selectedTreasury,
    selectedToken?.id || "",
    selectedToken?.network || "NEAR"
  );
  
  const { data: tokenData, isLoading: isTokenLoading } = useToken(selectedToken?.id || "");

  const estimatedUSDValue = useMemo(() => {
    if (!tokenData?.price || !amount || isNaN(Number(amount)) || Number(amount) <= 0) {
      return null;
    }
    return Number(amount) * tokenData.price;
  }, [amount, tokenData?.price]);


  // Validate structure only (fast, synchronous)
  const validateStructure = (address: string): string | undefined => {
    if (!address || address.trim() === "") {
      return undefined;
    }
    
    if (!isValidNearAddressFormat(address)) {
      return "Invalid NEAR account format";
    }
    
    return undefined;
  };

  // Full validation (checks blockchain)
  const validateRecipientFull = async (address: string) => {
    if (!address || address.trim() === "") {
      setRecipientError(undefined);
      return true;
    }

    setIsValidating(true);
    try {
      const error = await validateNearAddress(address);
      setRecipientError(error || undefined);
      return !error;
    } catch (err) {
      console.error("Validation error:", err);
      setRecipientError("Failed to validate address");
      return false;
    } finally {
      setIsValidating(false);
    }
  };

  // Handle save button click
  const handleSave = async () => {
    // Validate recipient on blockchain
    const isValid = await validateRecipientFull(recipient);
    
    if (isValid) {
      onSave();
    }
  };

  // Handle recipient change
  const handleRecipientChange = (value: string) => {
    onRecipientChange(value);
    
    // Validate structure immediately while typing
    const structureError = validateStructure(value);
    setRecipientError(structureError);
  };

  // Check if save button should be disabled
  const isSaveDisabled = !recipient || !amount || isValidating || !!recipientError;

  return (
    <>
      {/* You send section */}
      <InputBlock
        title="You send"
        invalid={false}
        topRightContent={
          showBalance && tokenBalanceData?.balance && !isBalanceLoading ? (
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Balance: {formatBalance(tokenBalanceData.balance, tokenBalanceData.decimals)}{" "}
                {selectedToken?.symbol?.toUpperCase()}
              </p>
              <Button
                type="button"
                variant="secondary"
                className="bg-muted-foreground/10 hover:bg-muted-foreground/20"
                size="sm"
                onClick={() => {
                  if (tokenBalanceData?.balance && tokenBalanceData?.decimals) {
                    onAmountChange(formatBalance(tokenBalanceData.balance, tokenBalanceData.decimals));
                  }
                }}
              >
                MAX
              </Button>
            </div>
          ) : null
        }
      >
        <div className="flex justify-between items-center">
          <div className="flex-1">
            <LargeInput
              type="number"
              borderless
              onChange={(e) => onAmountChange(e.target.value.replace(/^0+(?=\d)/, ""))}
              value={amount}
              placeholder="0"
              className="text-3xl!"
            />
          </div>
          <TokenSelect
            disabled={tokenLocked || !onTokenChange}
            locked={tokenLocked}
            lockedTokenData={
              tokenLocked && selectedToken
                ? {
                    symbol: selectedToken.symbol,
                    icon: selectedToken.icon,
                    network: selectedToken.network,
                    chainIcons: tokenData?.chainIcons,
                  }
                : undefined
            }
            selectedToken={selectedToken?.symbol || null}
            setSelectedToken={(token) => {
              if (onTokenChange) {
                onTokenChange(token);
              }
            }}
          />
        </div>
        <p
          className={cn(
            "text-muted-foreground text-xs invisible",
            estimatedUSDValue !== null && estimatedUSDValue > 0 && "visible"
          )}
        >
          {!isTokenLoading && estimatedUSDValue !== null && estimatedUSDValue > 0
            ? `≈ ${formatCurrency(estimatedUSDValue)}`
            : isTokenLoading
            ? "Loading price..."
            : "Invisible"}
        </p>
      </InputBlock>

      {/* To section */}
      <InputBlock title="To" invalid={!!recipientError}>
        <LargeInput
          type="text"
          borderless
          value={recipient}
          onChange={(e) => handleRecipientChange(e.target.value)}
          placeholder="Recipient address"
          disabled={isValidating}
        />
        {isValidating ? (
          <p className="text-muted-foreground text-xs">Validating address...</p>
        ) : recipientError ? (
          <p className="text-destructive text-xs">{recipientError}</p>
        ) : (
          <p className="text-muted-foreground text-xs invisible">Invisible</p>
        )}
      </InputBlock>

      {/* Save Button */}
      <Button
        onClick={handleSave}
        disabled={isSaveDisabled}
        className="w-full"
      >
        {isValidating ? "Validating..." : saveButtonText}
      </Button>
    </>
  );
}

