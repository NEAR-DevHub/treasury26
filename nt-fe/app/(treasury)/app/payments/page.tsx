"use client";

import { PageCard } from "@/components/card";
import { RecipientInput } from "@/components/recipient-input";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useFieldArray, useForm, useFormContext, } from "react-hook-form";
import { Form, FormField, FormMessage } from "@/components/ui/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { InputBlock } from "@/components/input-block";
import { ApprovalInfo } from "@/components/approval-info";
import { ReviewStep, StepperHeader, StepperNextButton, StepWizard } from "@/components/step-wizard";
import { useBatchStorageDepositIsRegistered, useBatchTokenPrices, useStorageDepositIsRegistered, useTokenPrice, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { Fragment, useEffect, useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { encodeToMarkdown } from "@/lib/utils";
import Big from "big.js";
import { ConnectorAction } from "@hot-labs/near-connect";
import { Button } from "@/components/button";
import { Plus, Trash } from "lucide-react";
import { NEAR_TOKEN } from "@/constants/token";

const paymentFormSchema = z.object({
  payments: z.array(z.object({
    address: z.string().min(2, "Recipient should be at least 2 characters").max(64, "Recipient must be less than 64 characters"),
    amount: z
      .string()
      .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
        message: "Amount must be greater than 0",
      }),
    memo: z.string().optional(),
    isRegistered: z.boolean().optional(),
  })),
  token: tokenSchema,
  approveWithMyVote: z.boolean()
}).superRefine((data, ctx) => {
  for (const [index, payment] of data.payments.entries()) {
    if (payment.address === data.token.address) {
      ctx.addIssue({
        code: "custom",
        path: [`payment.${index}.address`],
        message: "Recipient and token address cannot be the same",
      });
    }
  }
});

function Step1() {
  const form = useFormContext<PaymentFormValues>();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "payments",
  });
  return (
    <>
      <StepperHeader title="New Payment" />
      {fields.map((field, index) => (
        <Fragment key={field.id}>
          <TokenInput key={field.id} tokenSelect={{ disabled: index > 0 }} control={form.control} amountName={`payments.${index}.amount`} tokenName={`token`} />
          <RecipientInput control={form.control} name={`payments.${index}.address`} />
          {fields.length > 1 && (
            <div className="flex justify-end">
              <Button variant={'link'} type="button" className="text-muted-foreground/80 hover:text-muted-foreground" size={'sm'} onClick={() => remove(index)}><Trash className="size-3 text-primary" /> Remove Recipient</Button>
            </div>
          )}
        </Fragment>
      ))}
      <div className="flex justify-start">
        <Button variant={'link'} type="button" size={'sm'} onClick={() => append({ address: "", amount: "0", memo: "" })}><Plus className="size-3 text-primary" /> Add New Recipient</Button>
      </div>
      < ApprovalInfo />
    </>
  );
}

function Step2({ handleBack }: { handleBack?: () => void }) {
  const form = useFormContext<PaymentFormValues>();
  const { fields } = useFieldArray({
    control: form.control,
    name: "payments",
  });
  const token = form.watch("token");
  const { data: storageDepositData } = useBatchStorageDepositIsRegistered(fields.map((field) => ({ accountId: field.address, tokenId: token.address })));
  const { data: tokenPriceData } = useTokenPrice(token.address, token.network);

  useEffect(() => {
    if (!storageDepositData) return;

    // Match storage deposit data by accountId and tokenId, not by index
    for (const [index, field] of fields.entries()) {
      const matchingDeposit = storageDepositData.find(
        (deposit) => deposit.account_id === field.address
      );
      form.setValue(`payments.${index}.isRegistered`, matchingDeposit?.is_registered ?? false);
    }
  }, [storageDepositData, fields, form]);

  const totalEstimatedUSDValue = useMemo(() => {
    if (!tokenPriceData?.price) return 0;

    return fields.reduce((total, field) => {
      return total + (Number(field.amount) * tokenPriceData.price);
    }, 0);
  }, [fields, tokenPriceData]);


  return (
    <ReviewStep control={form.control} reviewingTitle="Review Your Payment" approveWithMyVoteName="approveWithMyVote" handleBack={handleBack}>
      <InputBlock title="" invalid={false}>
        <div className="flex flex-col gap-1 text-sm text-center">
          <p>You are sending a total of</p>
          <p className="text-2xl font-semibold">${totalEstimatedUSDValue.toLocaleString('en-US', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2
          })}</p>
          <p>to 1 recipient</p>
        </div>
      </InputBlock>
      <div className="flex flex-col gap-2">
        <p className="font-semibold">Recipients</p>
        {fields.map((field, index) => {
          const estimatedUSDValue = tokenPriceData?.price ? Number(field.amount) * tokenPriceData.price : 0;

          return (
            <div key={index} className="flex gap-2 items-baseline w-full">
              <div className="py-1.5 px-3 rounded-full bg-muted text-muted-foreground text-sm font-semibold">{index + 1}</div>
              <div className="flex flex-col gap-1 w-full">
                <div className="flex justify-between items-center w-full text-sm ">
                  <p className=" font-semibold">{field.address}</p>
                  <div className="flex items-center gap-2">
                    <img src={token.icon} alt={token.symbol} className="size-6 rounded-full" />
                    <div className="flex flex-col items-end">
                      <p className="text-sm font-semibold">{field.amount} {token.symbol}</p>
                      <p className="text-xs text-muted-foreground">≈ ${estimatedUSDValue.toLocaleString('en-US', {
                        minimumFractionDigits: 2,
                        maximumFractionDigits: 2
                      })}</p>
                    </div>
                  </div>
                </div>
                <FormField control={form.control} name={`payments.${index}.memo`} render={({ field }) => (
                  <Textarea
                    value={field.value}
                    onChange={field.onChange}
                    rows={2}
                    placeholder="Add a comment (optional)..."
                  />
                )} />
              </div>
            </div>
          );
        })}
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
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<PaymentFormValues>({
    resolver: zodResolver(paymentFormSchema),
    defaultValues: {
      payments: [{
        address: "",
        amount: "",
        memo: "",
      }],
      token: NEAR_TOKEN,
      approveWithMyVote: false,
    },
  });

  const onSubmit = async (data: PaymentFormValues) => {
    setIsSubmitting(true);
    if (data.payments.length > 0) {
      alert("Batch payments are not supported yet");
      return;
    }
    const payment = data.payments[0];
    try {
      const isNEAR = data.token.symbol === "NEAR";
      const description = {
        title: "Payment Request",
        notes: payment.memo || "",
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
                        token_id: isNEAR ? "" : data.token.address,
                        receiver_id: payment.address,
                        amount: Big(payment.amount).mul(Big(10).pow(data.token.decimals)).toFixed(),
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
        !payment.isRegistered &&
        !isNEAR

      if (needsStorageDeposit) {
        const depositInYocto = Big(0.125).mul(Big(10).pow(24)).toFixed();
        calls.push({
          receiverId: data.token.address,
          actions: [
            {
              type: "FunctionCall",
              params: {
                methodName: "storage_deposit",
                args: {
                  account_id: payment.address,
                  registration_only: true,
                } as any,
                gas,
                deposit: depositInYocto,
              },
            },
          ],
        });
      }

      await signAndSendTransactions({
        transactions: calls.map((call) => ({
          receiverId: call.receiverId!,
          actions: call.actions as ConnectorAction[],
        })),
        network: "mainnet",
      });
    } catch (error) {
      console.error("Payments error", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PageComponentLayout title="Payments" description="Send and receive funds securely">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 max-w-[600px] mx-auto">
          <PageCard className="gap-3">
            <StepWizard
              steps={[
                {
                  nextButton: ({ handleNext }) => StepperNextButton({ text: "Review Payment" })(() => {
                    form.trigger().then((isValid) => {
                      if (isValid) {
                        return handleNext();
                      }
                    });
                  }),
                  component: Step1,
                },
                {
                  nextButton: ({ }) => StepperNextButton({ text: "Confirm and Submit Request", loading: isSubmitting })(),
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

