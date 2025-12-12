"use client";

import { PageCard } from "@/components/card";
import { TokenInput } from "@/components/token-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useForm, useFormContext, } from "react-hook-form";
import { Form, FormField, FormMessage } from "@/components/ui/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import { ApprovalInfo } from "@/components/approval-info";
import { ReviewStep, StepperNextButton, StepWizard } from "@/components/step-wizard";
import { useStorageDepositIsRegistered, useTokenPrice, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useEffect, useMemo } from "react";
import { Textarea } from "@/components/ui/textarea";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { encodeToMarkdown } from "@/lib/utils";
import Big from "big.js";
import { ConnectorAction } from "@hot-labs/near-connect";

const paymentFormSchema = z.object({
  payment: z.object({
    address: z.string().min(2, "Recipient should be at least 2 characters").max(64, "Recipient must be less than 64 characters"),
    amount: z
      .string()
      .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
        message: "Amount must be greater than 0",
      }),
    memo: z.string().optional(),
    isRegistered: z.boolean().optional(),
    tokenSymbol: z.string().min(1, "Token symbol is required"),
    tokenAddress: z.string().min(1, "Token address is required"),
    tokenNetwork: z.string().min(1, "Token network is required"),
    tokenDecimals: z.number().min(1, "Token decimals is required"),
    tokenIcon: z.string().min(1, "Token icon is required"),
  }),
  approveWithMyVote: z.boolean()
}).superRefine((data, ctx) => {
  if (data.payment.address === data.payment.tokenAddress) {
    ctx.addIssue({
      code: "custom",
      path: ["recipient"],
      message: "Recipient and token address cannot be the same",
    });
  }

});

function Step1() {
  const form = useFormContext<PaymentFormValues>();
  return (
    <>
      <p className="font-semibold ">New Payment</p>
      <TokenInput control={form.control} amountName="payment.amount" tokenSymbolName="payment.tokenSymbol" tokenAddressName="payment.tokenAddress" tokenNetworkName="payment.tokenNetwork" tokenIconName="payment.tokenIcon" tokenDecimalsName="payment.tokenDecimals" />
      <FormField control={form.control} name="payment.address" render={({ field, fieldState }) => (
        <InputBlock title="To" invalid={!!fieldState.error}
        >
          <LargeInput type="text" borderless {...field} placeholder="Recipient address or name" />
          {fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Invisible</p>}
        </InputBlock>
      )} />
      <ApprovalInfo />
    </>
  );
}

function Step2({ handleBack }: { handleBack?: () => void }) {
  const form = useFormContext<PaymentFormValues>();
  const { payment } = form.watch();
  const { data: storageDepositData } = useStorageDepositIsRegistered(payment.address, payment.tokenAddress);
  const { data: tokenPriceData } = useTokenPrice(payment.tokenAddress, "NEAR");

  useEffect(() => {
    form.setValue("payment.isRegistered", !!storageDepositData);
  }, [storageDepositData]);

  const estimatedUSDValue = useMemo(() => {
    if (!tokenPriceData?.price) return 0;
    return Number(payment.amount) * tokenPriceData.price;
  }, [payment.amount, tokenPriceData?.price]);

  return (
    <ReviewStep control={form.control} reviewingTitle="Review Your Payment" approveWithMyVoteName="approveWithMyVote" handleBack={handleBack}>
      <InputBlock title="" invalid={false}>
        <div className="flex flex-col gap-1 text-sm text-center">
          <p>You are sending a total of</p>
          <p className="text-2xl font-semibold">${estimatedUSDValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })}</p>
          <p>to 1 recipient</p>
        </div>
      </InputBlock>
      <div className="flex flex-col gap-2">
        <p className="font-semibold">Recipients</p>
        {[payment].map((recipient, index) => (
          <div key={index} className="flex gap-2 items-baseline w-full">
            <div className="py-1.5 px-3 rounded-full bg-muted text-muted-foreground text-sm font-semibold">{index + 1}</div>
            <div className="flex flex-col gap-1 w-full">
              <div className="flex justify-between items-center w-full text-sm ">
                <p className=" font-semibold">{recipient.address}</p>
                <div className="flex items-center gap-2">
                  <img src={recipient.tokenIcon} alt={recipient.tokenSymbol} className="size-6 rounded-full" />
                  <div className="flex flex-col items-end">
                    <p className="text-sm font-semibold">{recipient.amount} {recipient.tokenSymbol}</p>
                    <p className="text-xs text-muted-foreground">≈ ${estimatedUSDValue.toLocaleString('en-US', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2
                    })}</p>
                  </div>
                </div>
              </div>
              <FormField control={form.control} name="payment.memo" render={({ field }) => (
                <Textarea
                  value={field.value}
                  onChange={field.onChange}
                  rows={2}
                  placeholder="Add a comment (optional)..."
                />
              )} />
            </div>
          </div>
        ))}
      </div>
      <></>
    </ReviewStep>
  );
}

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

export default function PaymentsPage() {
  const { selectedTreasury } = useTreasury();
  const { signAndSendTransactions } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      payment: {
        address: "",
        amount: "0",
        memo: "",
      },
      approveWithMyVote: false,
    },
  });

  console.log("Form values", form.getValues());

  const onSubmit = (data: PaymentFormValues) => {
    const isNEAR = data.payment.tokenSymbol === "NEAR";
    const description = {
      title: "Payment Request",
      notes: data.payment.memo || "",
    }
    const deposit = policy?.proposal_bond || 0;
    const gas = "270000000000000";

    const calls = [
      {
        receiverId: selectedTreasury,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "add_proposal",
              args: {
                proposal: {
                  description: encodeToMarkdown(description),
                  kind: {
                    Transfer: {
                      token_id: isNEAR ? "" : data.payment.tokenAddress,
                      receiver_id: data.payment.address,
                      amount: Big(data.payment.amount).mul(Big(10).pow(data.payment.tokenDecimals)).toFixed(),
                    },
                  },
                },
              },
              gas,
              deposit,
            },
          },
        ],
      },
    ];
    const needsStorageDeposit =
      !data.payment.isRegistered &&
      !isNEAR

    if (needsStorageDeposit) {
      const depositInYocto = Big(0.125).mul(Big(10).pow(24)).toFixed();
      calls.push({
        receiverId: data.payment.tokenAddress,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "storage_deposit",
              args: {
                account_id: data.payment.address,
                registration_only: true,
              } as any,
              gas,
              deposit: depositInYocto,
            },
          },
        ],
      });
    }

    console.log("Payments calls", calls);
    try {
      const result = signAndSendTransactions({
        transactions: calls.map((call) => ({
          receiverId: call.receiverId!,
          actions: call.actions as ConnectorAction[],
        })),
        network: "mainnet",
      });
      console.log("Payments result", result);
    } catch (error) {
      console.error("Payments error", error);
    }

  };

  console.log("Form errors", form.formState.errors);

  return (
    <PageComponentLayout title="Payments" description="Send and receive funds securely">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 max-w-[600px] mx-auto">
          <PageCard className="gap-3">
            <StepWizard
              steps={[
                {
                  nextButton: ({ handleNext }) => StepperNextButton({ text: "Review Payment" })(handleNext),
                  component: Step1,
                },
                {
                  nextButton: ({ }) => StepperNextButton({ text: "Confirm and Submit Request" })(),
                  component: Step2,
                }
              ]}
            />
          </PageCard>
        </form>
      </Form>
    </PageComponentLayout >
  );
}

