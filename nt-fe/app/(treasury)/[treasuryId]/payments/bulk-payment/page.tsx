"use client";

import { useState, useMemo, useEffect, useCallback } from "react";
import {
  ArrowLeft,
  Upload,
  FileText,
  DollarSign,
  Edit2,
  Trash2,
  Info,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/button";
import { PageComponentLayout } from "@/components/page-component-layout";
import { PageCard } from "@/components/card";
import { NEAR_TOKEN } from "@/constants/token";
import { Textarea } from "@/components/textarea";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import {
  getBatchStorageDepositIsRegistered,
  getBulkPaymentUsageStats,
} from "@/lib/api";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { toast } from "sonner";
import Big from "big.js";
import { PaymentFormSection } from "../components/payment-form-section";
import { WarningAlert } from "@/components/warning-alert";
import {
  viewStorageCredits,
  generateListId,
  submitPaymentList,
  buildApproveListProposal,
  TOTAL_FREE_CREDITS,
  MAX_RECIPIENTS_PER_BULK_PAYMENT,
  BULK_PAYMENT_CONTRACT_ID,
} from "@/lib/bulk-payment-api";
import { encodeToMarkdown, formatBalance } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import TokenSelect from "@/components/token-select";
import type { TreasuryAsset } from "@/lib/api";
import {
  validateNearAddress,
  isValidNearAddressFormat,
} from "@/lib/near-validation";
import { DialogDescription } from "@radix-ui/react-dialog";

interface BulkPaymentData {
  recipient: string;
  amount: string;
  memo?: string;
  isRegistered?: boolean;
  validationError?: string;
}

// Validation wrapper to match existing function signature
function validateRecipientAddress(address: string): string | null {
  if (!address || address.trim() === "") {
    return "Recipient address is required";
  }

  // Use the imported validation function (format-only check)
  if (!isValidNearAddressFormat(address)) {
    return "Invalid recipient address.";
  }

  return null;
}

// Helper function to check if storage deposit is needed for a token
function needsStorageDepositCheck(token: TreasuryAsset): boolean {
  // Intents tokens don't need storage deposits (they use a different system)
  // FT tokens need storage deposits
  // NEAR tokens don't need storage deposits
  return token.residency === "Ft";
}

// CSV Parsing Utilities
function parseCsv(raw: string) {
  const delimiters = [",", "\t", ";"];
  const lines = raw.trim().split(/\r?\n/);
  let bestDelimiter = ",";
  let maxColumns = 0;

  // Detect the best delimiter based on max column count in the header
  for (const delimiter of delimiters) {
    const cols = splitCsvLine(lines[0], delimiter).length;
    if (cols > maxColumns) {
      maxColumns = cols;
      bestDelimiter = delimiter;
    }
  }

  return lines.map((line) => splitCsvLine(line, bestDelimiter));
}

function splitCsvLine(line: string, delimiter: string) {
  const result: string[] = [];
  let field = "";
  let insideQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const nextChar = line[i + 1];

    if (char === '"') {
      if (insideQuotes && nextChar === '"') {
        field += '"'; // Escaped quote
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === delimiter && !insideQuotes) {
      result.push(field);
      field = "";
    } else {
      field += char;
    }
  }

  result.push(field);
  return result.map((f) => f.trim());
}

function parseAmount(amountStr: string): number {
  // Remove any spaces and currency symbols
  let normalized = amountStr.trim().replace(/[$€£¥]/g, "");
  // Handle different decimal separators (convert European format to standard)
  // If there's both comma and dot, assume comma is thousands separator
  if (normalized.includes(",") && normalized.includes(".")) {
    normalized = normalized.replace(/,/g, "");
  } else if (normalized.includes(",")) {
    // Check if comma is likely a decimal separator (e.g., "10,5" not "1,000")
    const parts = normalized.split(",");
    if (parts.length === 2 && parts[1].length <= 8) {
      // Likely decimal separator
      normalized = normalized.replace(",", ".");
    } else {
      // Likely thousands separator
      normalized = normalized.replace(/,/g, "");
    }
  }
  return parseFloat(normalized);
}

export default function BulkPaymentPage() {
  const router = useRouter();
  const { selectedTreasury } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);

  const [selectedToken, setSelectedToken] = useState<TreasuryAsset | null>(
    null
  );
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);
  const [paymentData, setPaymentData] = useState<BulkPaymentData[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [activeTab, setActiveTab] = useState<"upload" | "paste">("upload");
  const [showPreview, setShowPreview] = useState(false);
  const [showEditView, setShowEditView] = useState(false);
  const [comment, setComment] = useState("");
  const [csvData, setCsvData] = useState<string | null>(null);
  const [dataErrors, setDataErrors] = useState<Array<{
    row: number;
    message: string;
  }> | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isValidatingAccounts, setIsValidatingAccounts] = useState(false);
  const [validationComplete, setValidationComplete] = useState(false);
  const [availableCredits, setAvailableCredits] = useState(0); // Bulk payments per month
  const [creditsUsed, setCreditsUsed] = useState(0);
  const [isLoadingCredits, setIsLoadingCredits] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pasteDataInput, setPasteDataInput] = useState("");
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [deletingIndex, setDeletingIndex] = useState<number | null>(null);
  const [editFormData, setEditFormData] = useState<{
    recipient: string;
    amount: string;
  }>({
    recipient: "",
    amount: "",
  });

  // Calculate available bulk payments (storage credits returns bulk payments per month)
  useEffect(() => {
    async function fetchCredits() {
      if (!selectedTreasury) return;

      setIsLoadingCredits(true);
      try {
        // Fetch from both contract and database
        const [contractCredits, usageStats] = await Promise.all([
          viewStorageCredits(selectedTreasury),
          getBulkPaymentUsageStats(selectedTreasury),
        ]);

        // Contract credits = REMAINING storage records (not total)
        // This is already reduced by the contract when lists are submitted
        // So contractCredits already reflects what's available on-chain
        
        // Calculate how many bulk payment requests can be made
        // Each request can have up to MAX_RECIPIENTS_PER_BULK_PAYMENT recipients
        const maxRequestsFromContract = Math.floor(
          contractCredits / MAX_RECIPIENTS_PER_BULK_PAYMENT
        );

        // Database tracks requests we've created through the UI
        // This helps us show accurate usage even if contract hasn't processed yet
        const requestsUsedInDB = usageStats.total_requests;

        // Use the minimum to be conservative
        // (DB might be ahead if some requests are pending approval)
        const creditsAvailable = Math.min(
          maxRequestsFromContract,
          Math.max(0, TOTAL_FREE_CREDITS - requestsUsedInDB)
        );
        
        const creditsUsed = Math.min(requestsUsedInDB, TOTAL_FREE_CREDITS);

        setAvailableCredits(creditsAvailable);
        setCreditsUsed(creditsUsed);
      } catch (error) {
        console.error("Error loading bulk payment credits:", error);
        setAvailableCredits(0);
        setCreditsUsed(0);
      } finally {
        setIsLoadingCredits(false);
      }
    }

    fetchCredits();
  }, [selectedTreasury]);

  // Validate accounts exist on-chain when entering preview mode
  useEffect(() => {
    if (
      !showPreview ||
      paymentData.length === 0 ||
      !selectedToken ||
      validationComplete
    )
      return;

    const validateAccounts = async () => {
      setIsValidatingAccounts(true);

      try {
        // Step 1: Validate account existence first
        const accountValidatedPayments = await Promise.all(
          paymentData.map(async (payment) => {
            try {
              // Use validateNearAddress which checks both format and existence
              const validationError = await validateNearAddress(
                payment.recipient
              );

              return {
                ...payment,
                validationError: validationError || undefined,
              };
            } catch (error) {
              console.error(`Error validating ${payment.recipient}:`, error);
              return {
                ...payment,
                validationError: "Failed to validate account",
              };
            }
          })
        );

        // Step 2: Check storage registration for FT tokens (only for valid accounts)
        if (needsStorageDepositCheck(selectedToken)) {
          // Filter only valid accounts
          const validAccounts = accountValidatedPayments.filter(
            (payment) => !payment.validationError
          );

          if (validAccounts.length > 0) {
            const tokenId = selectedToken.contractId || selectedToken.id;

            // Build storage deposit requests
            const storageRequests = validAccounts.map((payment) => ({
              accountId: payment.recipient,
              tokenId: tokenId,
            }));

            // Call the API directly
            const storageRegistrations =
              await getBatchStorageDepositIsRegistered(storageRequests);

            // Create a map for quick lookup
            const registrationMap = new Map<string, boolean>();
            storageRegistrations.forEach((reg) => {
              registrationMap.set(
                `${reg.account_id}-${reg.token_id}`,
                reg.is_registered
              );
            });

            // Apply storage registration results
            const finalPayments = accountValidatedPayments.map((payment) => {
              if (payment.validationError) {
                return payment;
              }

              const key = `${payment.recipient}-${tokenId}`;
              const isRegistered = registrationMap.get(key) ?? false;

              return {
                ...payment,
                isRegistered,
              };
            });

            setPaymentData(finalPayments);
          } else {
            // No valid accounts, just update with validation errors
            setPaymentData(accountValidatedPayments);
          }
        } else {
          // NEAR token or no storage check needed
          setPaymentData(accountValidatedPayments);
        }

        setValidationComplete(true);
      } finally {
        setIsValidatingAccounts(false);
      }
    };

    validateAccounts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPreview]);

  const parsePasteData = useCallback(() => {
    const errors: Array<{ row: number; message: string }> = [];
    const parsedData: BulkPaymentData[] = [];

    // Replace literal \n with actual newlines (for when users paste escaped strings)
    const normalizedInput = pasteDataInput.replace(/\\n/g, "\n").trim();

    const lines = normalizedInput.split(/\r?\n/);

    if (lines.length === 0 || lines.every((line) => !line.trim())) {
      setDataErrors([{ row: 0, message: "No data provided" }]);
      setIsValidating(false);
      return;
    }

    let startRow = 0;

    // Check if first line is a header (case-insensitive)
    if (lines.length > 0) {
      const firstLine = lines[0].toLowerCase().trim();
      if (
        firstLine.includes("recipient") &&
        (firstLine.includes("amount") || firstLine.includes("value"))
      ) {
        startRow = 1; // Skip header row
      }
    }

    // Parse each line as "recipient, amount"
    for (let i = startRow; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;

      // Split by comma, tab, or multiple spaces
      const parts = line.split(/[,\t]+/).map((p) => p.trim());

      if (parts.length < 2) {
        errors.push({
          row: i + 1,
          message: `Invalid format. Expected: recipient, amount`,
        });
        continue;
      }

      const recipient = parts[0];
      const amountStr = parts[1];
      const parsedAmountValue = parseAmount(amountStr);

      if (isNaN(parsedAmountValue) || parsedAmountValue <= 0) {
        errors.push({ row: i + 1, message: `Invalid amount: ${amountStr}` });
        continue;
      }

      const validationError = validateRecipientAddress(recipient);

      parsedData.push({
        recipient,
        amount: String(parsedAmountValue),
        validationError: validationError || undefined,
      });
    }

    if (errors.length > 0) {
      setDataErrors(errors);
      setIsValidating(false);
      return;
    }

    if (parsedData.length === 0) {
      setDataErrors([{ row: 0, message: "No valid data found" }]);
      setIsValidating(false);
      return;
    }

    // Check if exceeds maximum recipients limit
    if (parsedData.length > MAX_RECIPIENTS_PER_BULK_PAYMENT) {
      setDataErrors([
        {
          row: 0,
          message: `Maximum limit of ${MAX_RECIPIENTS_PER_BULK_PAYMENT} transactions per request. Remove ${
            parsedData.length - MAX_RECIPIENTS_PER_BULK_PAYMENT
          } recipients to proceed.`,
        },
      ]);
      setIsValidating(false);
      return;
    }

    setDataErrors(null);
    setPaymentData(parsedData);
    setIsValidating(false);
    setValidationComplete(false); // Reset validation
    setShowPreview(true);
  }, [pasteDataInput, availableCredits, creditsUsed, availableCredits]);

  const parseAndValidateStructure = useCallback(() => {
    if (activeTab === "paste") {
      parsePasteData();
      return;
    }

    const errors: Array<{ row: number; message: string }> = [];
    const parsedData: BulkPaymentData[] = [];

    const rows = parseCsv(csvData || "");

    if (rows.length === 0) {
      setDataErrors([{ row: 0, message: "No data provided" }]);
      setIsValidating(false);
      return;
    }

    const firstRow = rows[0];

    // Check if first row is a header
    const hasHeader = firstRow.some((cell) => {
      const cellLower = (cell || "").trim().toLowerCase();
      return (
        cellLower.startsWith("recipient") || cellLower.startsWith("amount")
      );
    });

    let recipientIdx: number, amountIdx: number, startRow: number;

    if (hasHeader) {
      const colIdx = (name: string) =>
        firstRow.findIndex((h) =>
          (h || "").trim().toLowerCase().startsWith(name.toLowerCase())
        );

      recipientIdx = colIdx("Recipient");
      amountIdx = colIdx("Amount");

      if (recipientIdx === -1 || amountIdx === -1) {
        errors.push({
          row: 0,
          message: "Missing one or more required columns: Recipient, Amount",
        });
        setDataErrors(errors);
        setIsValidating(false);
        return;
      }

      startRow = 1;
    } else {
      recipientIdx = 0;
      amountIdx = 1;
      startRow = 0;
    }

    // Parse all rows
    for (let i = startRow; i < rows.length; i++) {
      const row = rows[i];

      if (row.every((cell) => !cell || !cell.trim())) {
        continue;
      }

      const recipient = (row[recipientIdx] || "").trim();
      const amountStr = (row[amountIdx] || "").trim();

      // Validate that both recipient and amount exist
      if (!recipient) {
        errors.push({
          row: i + 1,
          message: "Missing recipient address",
        });
        continue;
      }

      if (!amountStr) {
        errors.push({
          row: i + 1,
          message: "Missing amount",
        });
        continue;
      }

      const parsedAmountValue = parseAmount(amountStr);

      // Validate amount is a valid number
      if (isNaN(parsedAmountValue) || parsedAmountValue <= 0) {
        errors.push({
          row: i + 1,
          message: `Invalid amount: ${amountStr}`,
        });
        continue;
      }

      const validationError = validateRecipientAddress(recipient);

      const data: BulkPaymentData = {
        recipient,
        amount: String(parsedAmountValue),
        validationError: validationError || undefined,
      };

      parsedData.push(data);
    }

    // Check if there were any parsing errors
    if (errors.length > 0) {
      setDataErrors(errors);
      setIsValidating(false);
      return;
    }

    if (parsedData.length === 0) {
      setDataErrors([{ row: 0, message: "No valid data rows found" }]);
      setIsValidating(false);
      return;
    }

    // Check if exceeds maximum recipients limit
    if (parsedData.length > MAX_RECIPIENTS_PER_BULK_PAYMENT) {
      setDataErrors([
        {
          row: 0,
          message: `Maximum limit of ${MAX_RECIPIENTS_PER_BULK_PAYMENT} transactions per request. Remove ${
            parsedData.length - MAX_RECIPIENTS_PER_BULK_PAYMENT
          } recipients to proceed.`,
        },
      ]);
      setIsValidating(false);
      return;
    }

    setDataErrors(null);
    setPaymentData(parsedData);
    setIsValidating(false);
    setValidationComplete(false); // Reset validation
    setShowPreview(true);
  }, [
    csvData,
    availableCredits,
    creditsUsed,
    availableCredits,
    activeTab,
    parsePasteData,
  ]);

  const handleFileUpload = (file: File) => {
    if (file.type !== "text/csv" && !file.name.endsWith(".csv")) {
      toast.error("Please upload a CSV file");
      return;
    }

    if (file.size > 1.5 * 1024 * 1024) {
      toast.error("File size must be less than 1.5 MB");
      return;
    }

    setUploadedFile(file);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      setCsvData(text);
    };

    reader.readAsText(file);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file) {
      handleFileUpload(file);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = () => {
    setIsDragging(false);
  };

  const downloadTemplate = () => {
    const csvContent =
      "recipient,amount\nalice.near,10.5\nbob.near,25\ncharlie.near,100";
    const blob = new Blob([csvContent], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "bulk_payment_template.csv";
    a.click();
    URL.revokeObjectURL(url);
  };

  const totalAmount = useMemo(() => {
    return paymentData.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  }, [paymentData]);

  const handleRemoveRecipient = (index: number) => {
    setDeletingIndex(index);
  };

  const confirmRemoveRecipient = () => {
    if (deletingIndex === null) return;
    setPaymentData((prev) => prev.filter((_, i) => i !== deletingIndex));
    setDeletingIndex(null);
  };

  const handleEditRecipient = (index: number) => {
    const payment = paymentData[index];
    setEditFormData({
      recipient: payment.recipient,
      amount: payment.amount,
    });
    setEditingIndex(index);
    setShowEditView(true);
  };

  const handleSaveEdit = async () => {
    if (editingIndex === null || !selectedToken) return;

    // The PaymentFormSection already validated the account format and existence
    // Now check storage registration for FT tokens (skip for Intents)
    let isRegistered = true;
    if (needsStorageDepositCheck(selectedToken)) {
      try {
        const tokenId = selectedToken.contractId || selectedToken.id;
        const storageResult = await getBatchStorageDepositIsRegistered([
          {
            accountId: editFormData.recipient,
            tokenId: tokenId,
          },
        ]);
        if (storageResult.length > 0) {
          isRegistered = storageResult[0].is_registered;
        }
      } catch (error) {
        console.error("Error checking storage deposit:", error);
      }
    }

    const updatedPayments = [...paymentData];
    updatedPayments[editingIndex] = {
      ...updatedPayments[editingIndex],
      recipient: editFormData.recipient,
      amount: editFormData.amount,
      validationError: undefined,
      isRegistered,
    };
    setPaymentData(updatedPayments);

    // Go back to preview
    setShowEditView(false);
    setEditingIndex(null);
  };

  const handleCancelEdit = () => {
    setShowEditView(false);
    setEditingIndex(null);
  };

  const handleSubmit = async () => {
    if (!selectedTreasury || paymentData.length === 0 || !selectedToken) return;

    setIsSubmitting(true);

    try {
      const proposalBond = policy?.proposal_bond || "0";
      const isNEAR =
        selectedToken.id === NEAR_TOKEN.address ||
        selectedToken.symbol === "NEAR";

      // For backend hash generation: use "native" for NEAR, contractId for FT
      const tokenIdForHash = isNEAR
        ? "native"
        : selectedToken.contractId || selectedToken.id;

      // For proposal: use contractId for tokens
      const tokenIdForProposal = selectedToken.contractId || selectedToken.id;

      // Convert amounts to smallest units
      const payments = paymentData.map((payment) => ({
        recipient: payment.recipient,
        amount: Big(payment.amount || "0")
          .times(Big(10).pow(selectedToken.decimals))
          .toFixed(),
      }));

      // Generate list_id using "native" for NEAR, token address for FT (must match backend)
      const listId = await generateListId(
        selectedTreasury,
        tokenIdForHash,
        payments
      );

      // Build proposal description
      const description = encodeToMarkdown({
        proposal_action: "bulk-payment",
        title: comment || "Bulk Payment Request",
        recipients: paymentData.length,
        contract: selectedToken.symbol,
        amount: totalAmount.toFixed(),
        list_id: listId,
      });

      // Build proposal
      const totalAmountInSmallestUnits = Big(totalAmount)
        .times(Big(10).pow(selectedToken.decimals))
        .toFixed();

      const proposal = await buildApproveListProposal({
        daoAccountId: selectedTreasury,
        listId,
        tokenId: tokenIdForProposal,
        tokenResidency: selectedToken.residency,
        totalAmount: totalAmountInSmallestUnits,
        description,
        proposalBond,
      });

      // Build storage deposit transactions for unregistered recipients (FT tokens only, not Intents)
      const additionalTransactions: any[] = [];
      if (needsStorageDepositCheck(selectedToken)) {
        const gas = "30000000000000";
        const depositInYocto = Big(0.0125).mul(Big(10).pow(24)).toFixed();

        // First, check if bulk payment contract is registered for this token
        const bulkPaymentContractRegistration = await getBatchStorageDepositIsRegistered([
          {
            accountId: BULK_PAYMENT_CONTRACT_ID,
            tokenId: selectedToken.contractId || selectedToken.id,
          },
        ]);

        const isBulkPaymentContractRegistered =
          bulkPaymentContractRegistration.length > 0 &&
          bulkPaymentContractRegistration[0].is_registered;

      // Add storage deposit transaction for bulk payment contract if needed (must be first)
      if (!isBulkPaymentContractRegistered) {
        additionalTransactions.push({
          receiverId: selectedToken.contractId,
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: "storage_deposit",
                args: {
                  account_id: BULK_PAYMENT_CONTRACT_ID,
                  registration_only: true,
                } as any,
                gas,
                deposit: depositInYocto,
              },
            } as any,
          ],
        });
      }

      // Add storage deposits for unregistered recipients
      const unregisteredRecipients = paymentData.filter(
        (payment) =>
          payment.isRegistered === false && !payment.validationError
      );

      for (const payment of unregisteredRecipients) {
        additionalTransactions.push({
          receiverId: selectedToken.contractId,
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: "storage_deposit",
                args: {
                  account_id: payment.recipient,
                  registration_only: true,
                } as any,
                gas,
                deposit: depositInYocto,
              },
            } as any,
          ],
        });
      }

      // Add submit_list transaction to bulk payment contract
      // This stores the payment list in the contract before the DAO proposal is approved
      additionalTransactions.push({
        receiverId: BULK_PAYMENT_CONTRACT_ID,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "submit_list",
              args: {
                list_id: listId,
                token_id: tokenIdForHash,
                payments: payments.map((p) => ({
                  recipient: p.recipient,
                  amount: p.amount,
                })),
                submitter_id: selectedTreasury,
              } as any,
              gas: "50000000000000", // 50 TGas
              deposit: "0", // No deposit needed for submit_list
            },
          } as any,
        ],
      });
      }

      // Create proposal first (required for backend verification) - suppress toast
      const proposalResults = await createProposal(
        "Bulk payment proposal submitted",
        {
          treasuryId: selectedTreasury,
          proposal: {
            description: proposal.args.proposal.description,
            kind: proposal.args.proposal.kind,
          },
          proposalBond,
          additionalTransactions,
        },
        false
      ); // Don't show toast yet

      // Only submit payment list if proposal creation was successful
      if (proposalResults && proposalResults.length > 0) {
        // Submit payment list to backend (must be after proposal creation)
        try {
          await submitPaymentList({
            listId,
            submitterId: selectedTreasury,
            daoContractId: selectedTreasury,
            tokenId: tokenIdForHash, // Use "native" for NEAR, contractId for FT
            payments,
          });

          // Show success toast after list submission
          toast.success("Bulk Payment Request submitted", {
            duration: 10000, // 10 seconds
            action: {
              label: "View Request",
              onClick: () =>
                router.push(`/${selectedTreasury}/requests?tab=pending`),
            },
            classNames: {
              toast: "!p-2 !px-4",
              actionButton:
                "!bg-transparent !text-foreground hover:!bg-muted !border-0",
              title: "!border-r !border-r-border !pr-4",
            },
          });

          // Reset and close only on success
          setShowPreview(false);
          setPaymentData([]);
          setCsvData(null);
          setUploadedFile(null);
          setComment("");
        } catch (error) {
          console.error("Failed to submit payment list to backend:", error);
          toast.error("Failed to submit bulk payment list");
        }
      }
    } catch (error) {
      console.error("Failed to submit bulk payment:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  // Check if there are any unregistered recipients
  const hasUnregisteredRecipients = useMemo(() => {
    return paymentData.some((payment) => payment.isRegistered === false);
  }, [paymentData]);

  const hasValidationErrors = useMemo(() => {
    return paymentData.some((payment) => payment.validationError);
  }, [paymentData]);

  // Edit View Screen - For editing a single recipient
  if (showEditView && editingIndex !== null && selectedToken) {
    return (
      <PageComponentLayout title="Edit Payment" description="">
        <div className="max-w-[600px] mx-auto">
          <PageCard>
            <button
              onClick={handleCancelEdit}
              className="flex items-center gap-2 transition-colors mb-6"
            >
              <ArrowLeft className="w-5 h-5 text-muted-foreground hover:text-foreground" />
              <span className="text-lg font-semibold">Edit Payment</span>
            </button>

            <PaymentFormSection
              selectedToken={selectedToken}
              amount={editFormData.amount}
              onAmountChange={(amount) =>
                setEditFormData({ ...editFormData, amount })
              }
              recipient={editFormData.recipient}
              onRecipientChange={(recipient) => {
                setEditFormData({ ...editFormData, recipient });
              }}
              tokenLocked={true}
              showBalance={true}
              saveButtonText="Save"
              onSave={handleSaveEdit}
            />
          </PageCard>
        </div>
      </PageComponentLayout>
    );
  }

  // Preview Screen
  if (showPreview && selectedToken) {
    return (
      <PageComponentLayout title="Review Your Payment" description="">
        <div className="max-w-[600px] mx-auto">
          <PageCard>
            <button
              onClick={() => setShowPreview(false)}
              className="flex items-center gap-2 transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-muted-foreground" />
              <span className="text-lg font-semibold">Review Your Payment</span>
            </button>

            {/* Total Summary */}
            <div className="px-3.5 py-3 rounded-xl bg-muted">
              <div className="flex flex-col gap-2 p-2 text-xs text-muted-foreground text-center justify-center items-center">
                <p>You are sending a total of</p>
                <img
                  src={selectedToken.icon || ""}
                  alt={selectedToken.symbol}
                  className="size-10 shrink-0 rounded-full"
                />
                <p className="text-xl font-semibold text-foreground">
                  {totalAmount} {selectedToken.symbol}
                </p>
                <div>
                  <p>
                    to {paymentData.length} recipient
                    {paymentData.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
            </div>

            {/* Recipients List */}
            <div className="space-y-4 mb-2">
              <h3 className="text-sm text-muted-foreground mb-6">Recipients</h3>

              {isValidatingAccounts ? (
                // Loading skeleton while validating
                <>
                  {paymentData.map((_, index) => (
                    <div key={index} className="space-y-3">
                      <div className="flex items-start gap-3">
                        <div className="flex items-center justify-center w-6 h-6 rounded-full text-sm font-semibold shrink-0 bg-secondary text-foreground">
                          {index + 1}
                        </div>
                        <div className="flex-1">
                          <div className="flex justify-between mb-2">
                            <div className="flex flex-col gap-2 justify-between flex-1">
                              <div className="h-5 w-48 bg-muted animate-pulse rounded" />
                            </div>
                            <div>
                              <div className="flex flex-col gap-2 items-end">
                                <div className="h-5 w-32 bg-muted animate-pulse rounded" />
                                <div className="h-4 w-20 bg-muted animate-pulse rounded" />
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </>
              ) : (
                // Actual data after validation
                <>
                  {paymentData.map((payment, index) => {
                    const estimatedUSDValue =
                      selectedToken?.balanceUSD && selectedToken.balance
                        ? (Number(payment.amount) /
                            Number(
                              formatBalance(
                                selectedToken.balance.toString(),
                                selectedToken.decimals
                              )
                            )) *
                          selectedToken.balanceUSD
                        : 0;

                    return (
                      <div
                        key={index}
                        className={`space-y-3 ${
                          index < paymentData.length - 1
                            ? "border-b border-border pb-4"
                            : ""
                        }`}
                      >
                        <div className="flex items-start gap-3">
                          <div
                            className={`flex items-center justify-center w-6 h-6 rounded-full text-sm font-semibold shrink-0 ${
                              payment.validationError
                                ? "bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400"
                                : "bg-secondary text-foreground"
                            }`}
                          >
                            {index + 1}
                          </div>
                          <div className="flex-1">
                            <div className="flex justify-between mb-2">
                              <div className="flex flex-col gap-2 justify-between">
                                <div className="flex gap-2">
                                  <span className="font-semibold text-sm text-foreground">
                                    {payment.recipient}
                                  </span>
                                  {payment.isRegistered === false &&
                                    !payment.validationError && (
                                      <span className="px-2 py-1 text-xs font-medium bg-general-warning-background-faded text-general-warning-foreground rounded-full">
                                        Unregistered
                                      </span>
                                    )}
                                </div>
                                {payment.validationError && (
                                  <div className="text-xs text-red-600 dark:text-red-400 mb-2">
                                    {payment.validationError}
                                  </div>
                                )}
                              </div>

                              <div>
                                <div className="flex flex-col gap-2 items-end">
                                  <div className="flex items-center gap-2">
                                    <img
                                      src={selectedToken.icon || ""}
                                      alt={selectedToken.symbol}
                                      className="w-5 h-5 rounded-full"
                                    />
                                    <div className="text-right">
                                      <div className="text-sm font-semibold">
                                        {payment.amount} {selectedToken.symbol}
                                      </div>
                                      <div className="text-xs text-muted-foreground">
                                        ≈ ${estimatedUSDValue.toFixed(2)}
                                      </div>
                                    </div>
                                  </div>
                                  <div className="flex items-center gap-3 justify-end">
                                    <Button
                                      variant="unstyled"
                                      size="sm"
                                      className="text-muted-foreground hover:text-foreground px-0!"
                                      onClick={() => handleEditRecipient(index)}
                                    >
                                      <Edit2 className="w-4 h-4" /> Edit
                                    </Button>
                                    <Button
                                      variant="unstyled"
                                      size="sm"
                                      className="text-muted-foreground hover:text-foreground px-0!"
                                      onClick={() =>
                                        handleRemoveRecipient(index)
                                      }
                                    >
                                      <Trash2 className="w-4 h-4" /> Remove
                                    </Button>
                                  </div>
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </>
              )}
            </div>

            {/* Comment */}
            {!isValidatingAccounts && (
              <div className="mb-2">
                <Textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Add a comment (optional)..."
                  rows={3}
                  className="resize-none"
                />
              </div>
            )}

            {/* Storage Deposit Warning */}
            {!isValidatingAccounts && hasUnregisteredRecipients && (
              <WarningAlert
                className="mb-2"
                message={
                  <div>
                    <h4 className="font-semibold">Storage Deposit Required</h4>
                    <p>
                      A one-time gas fee of 0.0125 NEAR per{" "}
                      <span className="font-semibold">1 recipient</span> is
                      required to create their payment contract. You can pay now
                      or continue without these recipients.
                    </p>
                  </div>
                }
              />
            )}

            {/* Submit Button */}
            {!isValidatingAccounts && (
              <Button
                type="button"
                className="w-full"
                size="lg"
                onClick={handleSubmit}
                disabled={isSubmitting || hasValidationErrors}
              >
                {isSubmitting ? "Submitting..." : "Confirm and Submit Request"}
              </Button>
            )}
          </PageCard>

          {/* Delete Confirmation Modal */}
          <Dialog
            open={deletingIndex !== null}
            onOpenChange={(open) => !open && setDeletingIndex(null)}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Remove Recipient</DialogTitle>
              </DialogHeader>
              <DialogDescription>
                {deletingIndex !== null && paymentData[deletingIndex] && (
                  <p className="text-base">
                    Are you sure you want to remove the payment to{" "}
                    <span className="font-semibold">
                      {paymentData[deletingIndex].recipient}
                    </span>
                    ? This action cannot be undone.
                  </p>
                )}
              </DialogDescription>
              <DialogFooter>
                <Button
                  type="button"
                  variant="destructive"
                  className="w-full"
                  size="lg"
                  onClick={confirmRemoveRecipient}
                >
                  Remove
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </PageComponentLayout>
    );
  }

  // Upload Screen
  return (
    <PageComponentLayout title="Bulk Payment Requests">
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 max-w-[1200px] mx-auto">
        {/* Left Column - Main Form */}
        <div className="lg:col-span-2">
          <PageCard className="gap-2">
            <button
              onClick={() => router.back()}
              className="flex items-center gap-2 transition-colors"
            >
              <ArrowLeft className="w-4 h-4 text-muted-foreground hover:text-foreground" />
              <span className="text-xl font-semibold">
                Bulk Payment Requests
              </span>
            </button>

            <p className="text-sm text-muted-foreground font-medium mb-4">
              Pay multiple recipients with a single proposal.
            </p>

            {/* Credit Exhaustion Banner */}
            {availableCredits === 0 && (
              <div className="mb-6 p-4 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
                <div className="flex gap-3">
                  <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
                  <div className="flex-1">
                    <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
                      You've used all your credits
                    </p>
                    <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                      Upgrade your plan to get more and keep going
                    </p>
                  </div>
                </div>
              </div>
            )}

            {/* Step 1: Select Asset */}
            <div className="mb-6">
              <div className="flex gap-2 mb-4">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-foreground text-sm font-semibold">
                  1
                </div>
                <div className="flex-1 flex flex-col gap-2">
                  <h3 className="text-md font-semibold">Select Asset</h3>

                  <TokenSelect
                    selectedToken={selectedToken?.symbol || null}
                    setSelectedToken={setSelectedToken}
                    disabled={availableCredits === 0}
                    iconSize="lg"
                    classNames={{
                      trigger:
                        "w-full h-14 rounded-lg px-4 bg-muted hover:bg-muted/80 hover:border-none",
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Step 2: Provide Payment Data */}
            <div className="mb-6">
              <div className="flex gap-2 mb-4">
                <div className="flex items-center justify-center w-6 h-6 rounded-full bg-muted text-foreground text-sm font-semibold">
                  2
                </div>
                <div className="flex-1 flex flex-col gap-2">
                  <h3 className="text-md font-semibold">
                    Provide Payment Data
                  </h3>

                  {/* Tabs */}
                  <div className="flex gap-1 border-b">
                    <button
                      className={`px-4 py-2 text-sm font-medium transition-colors ${
                        activeTab === "upload"
                          ? "border-b-2 border-foreground text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => {
                        setActiveTab("upload");
                        setDataErrors(null);
                      }}
                    >
                      Upload File
                    </button>
                    <button
                      className={`px-4 py-2 text-sm font-medium transition-colors ${
                        activeTab === "paste"
                          ? "border-b-2 border-foreground text-foreground"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                      onClick={() => {
                        setActiveTab("paste");
                        setDataErrors(null);
                      }}
                    >
                      Provide Data
                    </button>
                  </div>
                  {/* Upload Tab Content */}
                  {activeTab === "upload" && (
                    <div className="space-y-4">
                      {!uploadedFile ? (
                        <div
                          className={`border-2 border-dashed rounded-lg p-12 text-center transition-colors ${
                            isDragging
                              ? "border-primary bg-primary/5"
                              : "border-border bg-muted"
                          }`}
                          onDrop={handleDrop}
                          onDragOver={handleDragOver}
                          onDragLeave={handleDragLeave}
                        >
                          <div className="flex flex-col items-center gap-4">
                            <Upload className="w-12 h-12 text-muted-foreground" />
                            <div>
                              <p className="text-base mb-2">
                                <button
                                  type="button"
                                  className="font-semibold hover:underline disabled:text-muted-foreground"
                                  onClick={() =>
                                    document
                                      .getElementById("file-upload")
                                      ?.click()
                                  }
                                  disabled={availableCredits === 0}
                                >
                                  Choose File
                                </button>{" "}
                                <span className="text-muted-foreground">
                                  or drag and drop
                                </span>
                              </p>
                              <p className="text-sm text-muted-foreground">
                                max 1 file up to 1.5 MB, CSV file only
                              </p>
                            </div>
                            <input
                              id="file-upload"
                              type="file"
                              accept=".csv"
                              className="hidden"
                              disabled={availableCredits === 0}
                              onChange={(e) => {
                                const file = e.target.files?.[0];
                                if (file) handleFileUpload(file);
                              }}
                            />
                          </div>
                        </div>
                      ) : (
                        <div className="bg-muted/50 rounded-lg p-4 flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <FileText className="w-5 h-5 text-primary" />
                            <div>
                              <p className="text-sm font-medium">
                                {uploadedFile.name}
                              </p>
                              <p className="text-xs text-muted-foreground">
                                {(uploadedFile.size / 1024).toFixed(0)}KB
                              </p>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => {
                              setUploadedFile(null);
                              setCsvData(null);
                              setDataErrors(null);
                            }}
                            className="text-sm text-muted-foreground hover:text-foreground"
                          >
                            Remove
                          </button>
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">
                          Don't have a file to upload?
                        </span>
                        <button
                          type="button"
                          onClick={downloadTemplate}
                          className="font-medium hover:underline text-general-unofficial-ghost-foreground"
                        >
                          Download a template
                        </button>
                      </div>
                    </div>
                  )}

                  {/* Paste Tab Content */}
                  {activeTab === "paste" && (
                    <div className="space-y-2">
                      <Textarea
                        value={pasteDataInput}
                        onChange={(e) => {
                          setPasteDataInput(e.target.value);
                          if (dataErrors && dataErrors.length > 0) {
                            setDataErrors(null);
                          }
                        }}
                        placeholder={`olskik.near, 100.00\nvova.near, 100.00\nmegha.near, 100.00`}
                        rows={8}
                        className={`resize-none font-mono text-sm bg-muted focus:outline-none ${
                          dataErrors && dataErrors.length > 0
                            ? "border-2 border-destructive focus:border-destructive"
                            : ""
                        }`}
                        disabled={availableCredits === 0}
                      />
                      {dataErrors && dataErrors.length > 0 && (
                        <div className="text-sm text-destructive">
                          {dataErrors.map((error, i) => (
                            <div key={i}>
                              {error.row > 0 ? `Row ${error.row}: ` : ""}
                              {error.message}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Upload Tab Errors */}
                  {activeTab === "upload" &&
                    dataErrors &&
                    dataErrors.length > 0 && (
                      <div className="text-sm text-destructive">
                        {dataErrors.map((error, i) => (
                          <div key={i}>
                            {error.row > 0 ? `Row ${error.row}: ` : ""}
                            {error.message}
                          </div>
                        ))}
                      </div>
                    )}
                </div>
              </div>
            </div>

            {/* Preview Button */}
            <Button
              type="button"
              className="w-full"
              size="lg"
              disabled={
                !selectedToken ||
                (activeTab === "upload" && (!uploadedFile || !csvData)) ||
                (activeTab === "paste" && !pasteDataInput.trim()) ||
                isValidating ||
                availableCredits === 0
              }
              onClick={() => {
                setIsValidating(true);
                parseAndValidateStructure();
              }}
            >
              {isValidating ? "Validating..." : "See Preview"}
            </Button>
          </PageCard>
        </div>

        {/* Right Column - Requirements & Credits */}
        <div className="space-y-4">
          {/* Requirements */}
          <PageCard
            style={{
              backgroundColor: "var(--color-general-tertiary)",
            }}
          >
            <h3 className="text-lg font-semibold">Bulk Payment Requirements</h3>
            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <FileText className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">
                    Max {MAX_RECIPIENTS_PER_BULK_PAYMENT} transactions per
                    import
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <DollarSign className="w-5 h-5 text-muted-foreground shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium">
                    Single token and network
                  </p>
                </div>
              </div>
            </div>
          </PageCard>

          {/* Credits Usage */}
          <PageCard
            style={
              availableCredits === 0
                ? {
                    border: "1px solid #34D6A4",
                    background: "#ECFDF5",
                  }
                : { backgroundColor: "var(--color-general-tertiary)" }
            }
          >
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold">Bulk Payments</h3>
                <span className="text-sm font-medium border-2 py-1 px-2 rounded-lg">
                  {TOTAL_FREE_CREDITS} credits
                </span>
              </div>

              <div className="space-y-2 border-b-[0.2px] border-general-unofficial-border pb-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-semibold">
                    {availableCredits} Available
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {creditsUsed} Used
                  </span>
                </div>
                <div className="w-full h-2 bg-general-unofficial-accent rounded-full overflow-hidden">
                  <div
                    className="h-full bg-foreground transition-all"
                    style={{
                      width:
                        availableCredits > 0
                          ? `${(creditsUsed / TOTAL_FREE_CREDITS) * 100}%`
                          : "0%",
                    }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-secondary-foreground">
                  Need more credits?
                </span>
                <Button
                  variant={availableCredits === 0 ? "default" : "outline"}
                  size="sm"
                  className="p-3!"
                >
                  Upgrade Plan
                </Button>
              </div>
            </div>
          </PageCard>
        </div>
      </div>
    </PageComponentLayout>
  );
}
