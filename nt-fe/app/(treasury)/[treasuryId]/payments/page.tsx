"use client";

import { PageCard } from "@/components/card";
import { RecipientInput } from "@/components/recipient-input";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { useFieldArray, useForm, useFormContext, } from "react-hook-form";
import { Form, FormField } from "@/components/ui/form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { ReviewStep, StepperHeader, InlineNextButton, StepProps, StepWizard } from "@/components/step-wizard";
import { useBatchStorageDepositIsRegistered, useTokenPrice, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { Fragment, useEffect, useMemo } from "react";
import { Textarea } from "@/components/textarea";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { encodeToMarkdown } from "@/lib/utils";
import Big from "big.js";
import { ConnectorAction } from "@hot-labs/near-connect";
import { Button } from "@/components/button";
import { Plus, Trash } from "lucide-react";
import { NEAR_TOKEN } from "@/constants/token";
import { SendingTotal } from "@/components/sending-total";
import { CircleNumber } from "@/components/circle-number";

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

function Step1({ handleNext }: StepProps) {
  const form = useFormContext<PaymentFormValues>();
  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "payments",
  });

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
      {fields.map((field, index) => (
        <Fragment key={field.id}>
          <TokenInput title="You send" key={field.id} tokenSelect={{ disabled: index > 0 }} control={form.control} amountName={`payments.${index}.amount`} tokenName={`token`} />
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

      <InlineNextButton text="Review Payment" onClick={handleContinue} />
    </PageCard>
  );
}

function Step2({ handleBack }: StepProps) {
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

  const total = useMemo(() => {
    return fields.reduce((total, field) => {
      return total + Number(field.amount);
    }, 0);
  }, [fields]);


  return (
    <PageCard>
      <ReviewStep control={form.control} reviewingTitle="Review Your Payment" approveWithMyVoteName="approveWithMyVote" proposalKind="transfer" handleBack={handleBack}>
        <SendingTotal total={total} token={token}>
          <p>to {fields.length} recipient{fields.length > 1 ? 's' : ''}</p>
        </SendingTotal>
        <div className="flex flex-col gap-2">
          <p className="font-semibold">Recipient{fields.length > 1 ? 's' : ''}</p>
          {fields.map((field, index) => {
            const estimatedUSDValue = tokenPriceData?.price ? Number(field.amount) * tokenPriceData.price : 0;

            return (
              <div key={index} className="flex gap-2 items-baseline w-full">
                <CircleNumber number={index + 1} />
                <div className="flex flex-col gap-1 w-full">
                  <div className="flex justify-between items-center w-full text-xs ">
                    <p className=" font-semibold">{field.address}</p>
                    <div className="flex items-center gap-2">
                      <img src={token.icon} alt={token.symbol} className="size-5 rounded-full" />
                      <div className="flex flex-col gap-[3px] items-end">
                        <p className="text-xs font-semibold">{field.amount} {token.symbol}</p>
                        <p className="text-[10px] text-muted-foreground">≈ ${estimatedUSDValue.toLocaleString('en-US', {
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
    if (data.payments.length > 1) {
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
      const proposalBond = policy?.proposal_bond || "0";
      const gas = "270000000000000";

      const additionalTransactions: Array<{
        receiverId: string;
        actions: ConnectorAction[];
      }> = [];

      const needsStorageDeposit = !payment.isRegistered && !isNEAR;

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
                  account_id: payment.address,
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
              receiver_id: payment.address,
              amount: Big(payment.amount).mul(Big(10).pow(data.token.decimals)).toFixed(),
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

