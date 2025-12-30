"use client";

import { PageCard } from "@/components/card";
import { RecipientInput } from "@/components/recipient-input";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useForm, useFormContext } from "react-hook-form";
import { Form, FormField } from "@/components/ui/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ReviewStep, StepperHeader, InlineNextButton, StepProps, StepWizard } from "@/components/step-wizard";
import { useStorageDepositIsRegistered, useToken, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useEffect, useMemo } from "react";
import { Textarea } from "@/components/textarea";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { encodeToMarkdown } from "@/lib/utils";
import Big from "big.js";
import { ConnectorAction } from "@hot-labs/near-connect";
import { NEAR_TOKEN } from "@/constants/token";
import { SendingTotal } from "@/components/sending-total";

const paymentFormSchema = z.object({
  address: z.string().min(2, "Recipient should be at least 2 characters").max(64, "Recipient must be less than 64 characters"),
  amount: z
    .string()
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: "Amount must be greater than 0",
    }),
  memo: z.string().optional(),
  isRegistered: z.boolean().optional(),
  token: tokenSchema,
}).superRefine((data, ctx) => {
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

  console.log("form.formState.errors", form.formState.errors);
  const handleContinue = () => {
    form.trigger().then((isValid) => {
      if (isValid && handleNext) {
        handleNext();
      }
    });
  };

  return (
    <PageCard>
      <StepperHeader title="New Payment" />
      <TokenInput title="You send" control={form.control} amountName="amount" tokenName="token" />
      <RecipientInput control={form.control} name="address" />
      <InlineNextButton text="Review Payment" onClick={handleContinue} />
    </PageCard>
  );
}

function Step2({ handleBack }: StepProps) {
  const form = useFormContext<PaymentFormValues>();
  const token = form.watch("token");
  const address = form.watch("address");
  const amount = form.watch("amount");
  const { data: storageDepositData } = useStorageDepositIsRegistered(address, token.address);
  const { data: tokenData } = useToken(token.address, token.network);

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
                <img src={token.icon} alt={token.symbol} className="size-5 rounded-full" />
                <div className="flex flex-col gap-[3px] items-end">
                  <p className="text-xs font-semibold">{amount} {token.symbol}</p>
                  <p className="text-[10px] text-muted-foreground">≈ ${estimatedUSDValue.toLocaleString('en-US', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2
                  })}</p>
                </div>
              </div>
            </div>
            <FormField control={form.control} name="memo" render={({ field }) => (
              <Textarea
                value={field.value}
                onChange={field.onChange}
                rows={2}
                placeholder="Add a comment (optional)..."
              />
            )} />
          </div>
        </div>
        <></>
      </ReviewStep>

      <InlineNextButton text="Confirm and Submit Request" loading={form.formState.isSubmitting} />
    </PageCard>
  );
}

type PaymentFormValues = z.infer<typeof paymentFormSchema>;

export default function PaymentsPage() {
  const { selectedTreasury } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);

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
      }
      const proposalBond = policy?.proposal_bond || "0";
      const gas = "270000000000000";

      const additionalTransactions: Array<{
        receiverId: string;
        actions: ConnectorAction[];
      }> = [];

      const needsStorageDeposit = !data.isRegistered && !isNEAR;

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

      await createProposal("Request to send payment submitted", {
        treasuryId: selectedTreasury!,
        proposal: {
          description: encodeToMarkdown(description),
          kind: {
            Transfer: {
              token_id: isNEAR ? "" : data.token.address,
              receiver_id: data.address,
              amount: Big(data.amount).mul(Big(10).pow(data.token.decimals)).toFixed(),
            },
          },
        },
        proposalBond,
        additionalTransactions,
      });
      form.reset(form.getValues());
    } catch (error) {
      console.error("Payments error", error);
    }
  };

  return (
    <PageComponentLayout title="Payments" description="Send and receive funds securely">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 max-w-[600px] mx-auto">
          <StepWizard
            steps={[
              {
                component: Step1,
              },
              {
                component: Step2,
              }
            ]}
          />
        </form>
      </Form>
    </PageComponentLayout >
  );
}

