"use client";

import { PageCard } from "@/components/card";
import { RecipientInput } from "@/components/recipient-input";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useForm, useFormContext } from "react-hook-form";
import { Form, FormField } from "@/components/ui/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ReviewStep, StepperHeader, StepProps, StepWizard } from "@/components/step-wizard";
import { useStorageDepositIsRegistered, useToken, useTokenBalance, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useEffect, useMemo, useState } from "react";
import { Textarea } from "@/components/textarea";
import { useTreasury } from "@/hooks/use-treasury";
import { useNear } from "@/stores/near-store";
import { encodeToMarkdown, formatCurrency } from "@/lib/utils";
import Big from "big.js";
import { ConnectorAction } from "@hot-labs/near-connect";
import { NEAR_TOKEN } from "@/constants/token";
import { SendingTotal } from "@/components/sending-total";
import { FunctionCallKind, TransferKind } from "@/lib/proposals-api";
import { CreateRequestButton } from "@/components/create-request-button";
import { PendingButton } from "@/components/pending-button";
import {
  usePageTour,
  useManualPageTour,
  PAGE_TOUR_NAMES,
  PAGE_TOUR_STORAGE_KEYS,
} from "@/features/onboarding/steps/page-tours";
import { Button } from "@/components/button";
import { ArrowDownToLine } from "lucide-react";
import Link from "next/link";

const paymentFormSchema = z
  .object({
    address: z
      .string()
      .min(2, "Recipient should be at least 2 characters")
      .max(64, "Recipient must be less than 64 characters"),
    amount: z.string().refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: "Amount must be greater than 0",
    }),
    memo: z.string().optional(),
    isRegistered: z.boolean().optional(),
    token: tokenSchema,
  })
  .superRefine((data, ctx) => {
    if (data.address === data.token.address) {
      ctx.addIssue({
        code: "custom",
        path: ["address"],
        message: "Recipient and token address cannot be the same",
      });
    }
  });

function Step1({ handleNext }: StepProps) {
  const form = useFormContext<PaymentFormValues>();
  const { treasuryId } = useTreasury();
  const token = form.watch("token");
  const amount = form.watch("amount");
  
  const { data: tokenBalance } = useTokenBalance(
    treasuryId,
    token.address,
    token.network
  );

  // Check for insufficient balance
  const hasInsufficientBalance = useMemo(() => {
    if (!amount || !tokenBalance?.balance) return false;
    try {
      const amountBig = new Big(amount);
      const balanceBig = new Big(tokenBalance.balance).div(
        new Big(10).pow(tokenBalance.decimals)
      );
      return amountBig.gt(balanceBig);
    } catch {
      return false;
    }
  }, [amount, tokenBalance]);
  const handleContinue = () => {
    form.trigger().then((isValid) => {
      if (isValid && handleNext) {
        handleNext();
      }
    });
  };

  return (
    <PageCard>
      <div className="flex justify-between items-center">
        <h2 className="text-xl font-semibold">New Payment</h2>
        <div className="flex items-center gap-3">
          <Link href={`/${treasuryId}/payments/bulk-payment`}>
            <Button
              variant="ghost"
              className="flex items-center gap-2 border-2"
            >
              <ArrowDownToLine className="w-4 h-4" />
              Bulk Payments
            </Button>
          </Link>
          <PendingButton
            id="payments-pending-btn"
            types={["Payments"]}
          />
        </div>
      </div>
      <TokenInput
        title="You send"
        control={form.control}
        amountName="amount"
        tokenName="token"
        infoMessage={
          hasInsufficientBalance
            ? "Insufficient tokens. You can submit the request and top up before approval."
            : undefined
        }
      />
      <RecipientInput control={form.control} name="address" />
      <div className="rounded-lg border bg-card p-0 overflow-hidden">
        <CreateRequestButton
          onClick={handleContinue}
          className="w-full h-10 rounded-none"
          permissions={[
            { kind: "transfer", action: "AddProposal" },
            { kind: "call", action: "AddProposal" },
          ]}
          idleMessage="Review Payment"
        />
      </div>
    </PageCard>
  );
}

function Step2({ handleBack }: StepProps) {
  const form = useFormContext<PaymentFormValues>();
  const token = form.watch("token");
  const address = form.watch("address");
  const amount = form.watch("amount");
  const { data: storageDepositData } = useStorageDepositIsRegistered(
    address,
    token.address
  );
  const { data: tokenData } = useToken(token.address);

  useEffect(() => {
    if (storageDepositData !== undefined) {
      form.setValue("isRegistered", storageDepositData);
    }
  }, [storageDepositData, form]);

  const total = useMemo(() => {
    return Number(amount) || 0;
  }, [amount]);

  const estimatedUSDValue = tokenData?.price ? total * tokenData.price : 0;

  return (
    <PageCard>
      <ReviewStep reviewingTitle="Review Your Payment" handleBack={handleBack}>
        <SendingTotal total={total} token={token}>
          <p>to 1 recipient</p>
        </SendingTotal>
        <div className="flex flex-col gap-2">
          <p className="font-semibold">Recipient</p>
          <div className="flex flex-col gap-1 w-full">
            <div className="flex justify-between items-center w-full text-xs ">
              <p className=" font-semibold">{address}</p>
              <div className="flex items-center gap-2">
                <img
                  src={token.icon}
                  alt={token.symbol}
                  className="size-5 rounded-full"
                />
                <div className="flex flex-col gap-[3px] items-end">
                  <p className="text-xs font-semibold">{amount} {token.symbol}</p>
                  <p className="text-xxs text-muted-foreground">≈ {formatCurrency(estimatedUSDValue)}</p>
                </div>
              </div>
            </div>
            <FormField
              control={form.control}
              name="memo"
              render={({ field }) => (
                <Textarea
                  value={field.value}
                  onChange={field.onChange}
                  rows={2}
                  placeholder="Add a comment (optional)..."
                />
              )}
            />
          </div>
        </div>
        <></>
      </ReviewStep>

      <div className="rounded-lg border bg-card p-0 overflow-hidden">
        <CreateRequestButton
          isSubmitting={form.formState.isSubmitting}
          type="submit"
          className="w-full h-10 rounded-none"
          permissions={[
            { kind: "transfer", action: "AddProposal" },
            { kind: "call", action: "AddProposal" },
          ]}
          idleMessage="Confirm and Submit Request"
        />
      </div>
    </PageCard>
  );
}

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

const buildIntentProposal = (
  data: PaymentFormValues,
  parsedAmount: string,
  gasForIntentAction: string
): FunctionCallKind => {
  const isNetworkWithdrawal = data.token.network !== "near";
  const tokenContract = data.token.address.replace("nep141:", "");

  const ftWithdrawArgs = isNetworkWithdrawal
    ? {
        token: tokenContract,
        receiver_id: tokenContract,
        amount: parsedAmount,
        memo: `WITHDRAW_TO:${data.address}`,
      }
    : {
        token: tokenContract,
        receiver_id: data.address,
        amount: parsedAmount,
      };

  return {
    FunctionCall: {
      receiver_id: "intents.near",
      actions: [
        {
          method_name: "ft_withdraw",
          args: Buffer.from(JSON.stringify(ftWithdrawArgs)).toString("base64"),
          deposit: "1",
          gas: gasForIntentAction,
        },
      ],
    },
  };
};

const buildTransferProposal = (
  data: PaymentFormValues,
  parsedAmount: string
): TransferKind => {
  const isNEAR = data.token.symbol === "NEAR";
  return {
    Transfer: {
      token_id: isNEAR ? "" : data.token.address,
      receiver_id: data.address,
      amount: parsedAmount,
      msg: null,
    },
  };
};

export default function PaymentsPage() {
  const { treasuryId } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(treasuryId);
  const [step, setStep] = useState(0);

  // Onboarding tours
  usePageTour(PAGE_TOUR_NAMES.PAYMENTS_BULK, PAGE_TOUR_STORAGE_KEYS.PAYMENTS_BULK_SHOWN);
  const { triggerTour: triggerPendingTour } = useManualPageTour(
    PAGE_TOUR_NAMES.PAYMENTS_PENDING,
    PAGE_TOUR_STORAGE_KEYS.PAYMENTS_PENDING_SHOWN
  );

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      address: "",
      amount: "",
      memo: "",
      token: NEAR_TOKEN,
    },
  });

  const onSubmit = async (data: PaymentFormValues) => {
    try {
      const isNEAR = data.token.symbol === "NEAR";
      const description = {
        title: "Payment Request",
        notes: data.memo || "",
      };
      const proposalBond = policy?.proposal_bond || "0";
      const gas = "270000000000000";
      const gasForIntentAction = Big(30).mul(Big(10).pow(12)).toFixed(); // 30 Tgas for ft_withdraw

      const additionalTransactions: Array<{
        receiverId: string;
        actions: ConnectorAction[];
      }> = [];
      const isSelectedTokenIntents = data.token.address.startsWith("nep141:");

      const needsStorageDeposit =
        !data.isRegistered && !isNEAR && !isSelectedTokenIntents;

      if (needsStorageDeposit) {
        const depositInYocto = Big(0.125).mul(Big(10).pow(24)).toFixed();
        additionalTransactions.push({
          receiverId: data.token.address,
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: "storage_deposit",
                args: {
                  account_id: data.address,
                  registration_only: true,
                } as any,
                gas,
                deposit: depositInYocto,
              },
            } as ConnectorAction,
          ],
        });
      }

      const parsedAmount = Big(data.amount)
        .mul(Big(10).pow(data.token.decimals))
        .toFixed();

      const proposalKind = isSelectedTokenIntents
        ? buildIntentProposal(data, parsedAmount, gasForIntentAction)
        : buildTransferProposal(data, parsedAmount);

      await createProposal("Request to send payment submitted", {
        treasuryId: treasuryId!,
        proposal: {
          description: encodeToMarkdown(description),
          kind: proposalKind,
        },
        proposalBond,
        additionalTransactions,
      })
        .then(() => {
          form.reset();
          setStep(0);
        })
        .catch((error) => {
          console.error("Payments error", error);
        });
    } catch (error) {
      console.error("Payments error", error);
    }
  };

  return (
    <PageComponentLayout
      title="Payments"
      description="Send and receive funds securely"
    >
      <Form {...form}>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="flex flex-col gap-4 max-w-[600px] mx-auto"
        >
          <StepWizard
            step={step}
            onStepChange={setStep}
            steps={[
              {
                component: Step1,
              },
              {
                component: Step2,
              },
            ]}
          />
        </form>
      </Form>
    </PageComponentLayout>
  );
}
