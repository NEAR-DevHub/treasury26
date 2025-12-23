"use client";

import { PageCard } from "@/components/card";
import { CheckboxInput } from "@/components/checkbox-input";
import { DateInput } from "@/components/date-input";
import { InfoDisplay } from "@/components/info-display";
import { InputBlock } from "@/components/input-block";
import { PageComponentLayout } from "@/components/page-component-layout";
import { RecipientInput } from "@/components/recipient-input";
import { ReviewStep, StepperHeader, StepperNextButton, StepProps, StepWizard } from "@/components/step-wizard";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { Form, FormField } from "@/components/ui/form";
import { Textarea } from "@/components/textarea";
import { NEAR_TOKEN } from "@/constants/token";
import { useTokenPrice, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { encodeToMarkdown, formatDate, formatTimestamp, toBase64 } from "@/lib/utils";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/stores/treasury-store";
import { zodResolver } from "@hookform/resolvers/zod";
import Big from "big.js";
import { useMemo, useState } from "react";
import { useForm, useFormContext } from "react-hook-form";
import z from "zod";
import { LOCKUP_NO_WHITELIST_ACCOUNT_ID } from "@/constants/config";
import { SendingTotal } from "@/components/sending-total";

const vestingFormSchema = z.object({
  vesting: z.object({
    address: z.string().min(2, "Recipient should be at least 2 characters").max(64, "Recipient must be less than 64 characters"),
    amount: z
      .string()
      .refine((val) => !isNaN(Number(val)) && Number(val) >= 3.5, {
        message: "Amount must be greater than or equal to 3.5",
      }),
    memo: z.string().optional(),
    isRegistered: z.boolean().optional(),
    token: tokenSchema,
    startDate: z.date({ message: "Start date is required" }),
    endDate: z.date({ message: "End date is required" }),
    cliffDate: z.date({ message: "Cliff date is required" }).optional(),
    allowEarn: z.boolean().optional(),
    allowCancel: z.boolean().optional(),
  }),
  approveWithMyVote: z.boolean()
}).superRefine((data, ctx) => {
  if (data.vesting.address === data.vesting.token.address) {
    ctx.addIssue({
      code: "custom",
      path: [`vesting.address`],
      message: "Recipient and token address cannot be the same",
    });
  }
  if (data.vesting.startDate >= data.vesting.endDate) {
    ctx.addIssue({
      code: "custom",
      path: [`vesting.endDate`],
      message: "Start date must be before end date",
    });
  }

  if (data.vesting.cliffDate) {
    if (data.vesting.cliffDate < data.vesting.startDate || data.vesting.cliffDate >= data.vesting.endDate) {
      ctx.addIssue({
        code: "custom",
        path: [`vesting.cliffDate`],
        message: `Cliff date must be between ${formatDate(data.vesting.startDate)} and ${formatDate(data.vesting.endDate)}`,
      });
    }

  }
});

type VestingFormValues = z.infer<typeof vestingFormSchema>;

function Step1() {
  const form = useFormContext<VestingFormValues>();
  const startDate = form.watch("vesting.startDate");
  const endDate = form.watch("vesting.endDate");

  return (
    <PageCard>
      <StepperHeader title="New Vesting Schedule" />
      <TokenInput title="Amount" tokenSelect={{
        locked: true,
      }} control={form.control} amountName={`vesting.amount`} tokenName={`vesting.token`} />
      <RecipientInput control={form.control} name="vesting.address" />

      <div className="grid grid-cols-2 gap-4">
        <DateInput control={form.control} name="vesting.startDate" title="Start Date" maxDate={endDate} />
        <DateInput control={form.control} name="vesting.endDate" title="End Date" minDate={startDate} />
      </div>
    </PageCard>)
}

function Step2({ handleBack }: StepProps) {
  const form = useFormContext<VestingFormValues>();
  const allowCancel = form.watch("vesting.allowCancel");
  const startDate = form.watch("vesting.startDate");
  const endDate = form.watch("vesting.endDate");
  return (
    <PageCard>
      <StepperHeader title="Advanced Settings" handleBack={handleBack} />
      <CheckboxInput
        control={form.control}
        name="vesting.allowCancel"
        title="Allow Cancellation"
        description="Allows the NEAR Foundation to cancel the lockup at any time. Non-cancellable lockups are not compatible with cliff dates."
      />
      {allowCancel && (
        <DateInput control={form.control} name="vesting.cliffDate" title="Cliff Date" minDate={startDate} maxDate={endDate} />
      )}
      <CheckboxInput
        control={form.control}
        name="vesting.allowEarn"
        title="Allow Earn"
        description="Allows the owner of the lockup to stake the full amount of tokens in the lockup (even before the cliff date)."
      />
      <FormField control={form.control} name={`vesting.memo`} render={({ field }) => (
        <InputBlock title="Note (optional)" invalid={false}>
          <Textarea
            borderless
            value={field.value}
            onChange={field.onChange}
            rows={2}
            className="p-0 pt-1"
            placeholder="Add a comment for this vesting schedule (optional)..."
          />
        </InputBlock>
      )} />
    </PageCard>
  )
}

function Step3({ handleBack }: StepProps) {
  const form = useFormContext<VestingFormValues>();
  const { vesting } = form.watch()
  const { data: usdPrice } = useTokenPrice(vesting.token.address, vesting.token.network);

  const estimatedUSDValue = useMemo(() => {
    if (!usdPrice?.price || !vesting.amount || isNaN(Number(vesting.amount))) {
      return 0;
    }
    return Number(vesting.amount) * usdPrice.price;
  }, [usdPrice?.price, vesting.amount]);

  const infoItems = useMemo(() => {
    let items = [
      {
        label: "Recipient",
        value: vesting.address,
      },
      {
        label: "Start Date",
        value: formatDate(vesting.startDate),
      },
      {
        label: "End Date",
        value: formatDate(vesting.endDate),
      },
      {
        label: "Cliff Date",
        value: vesting.cliffDate ? formatDate(vesting.cliffDate) : "N/A",
      },
      {
        label: 'Cancelable',
        value: vesting.allowCancel ? "Yes" : "No",
      },
      {
        label: 'Allow Earn',
        value: vesting.allowEarn ? "Yes" : "No",
      },
    ];

    return items;
  }, [vesting]);

  return (
    <PageCard>
      <ReviewStep control={form.control} reviewingTitle="Review Your Vesting Schedule" approveWithMyVoteName="approveWithMyVote" proposalKind="call" handleBack={handleBack}>
        <div className="flex flex-col gap-6">
          <SendingTotal total={Number(vesting.amount)} token={vesting.token}>
            <p>≈ ${estimatedUSDValue.toLocaleString('en-US', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2
            })}</p>
          </SendingTotal>
          <InfoDisplay items={infoItems} />
        </div>
      </ReviewStep>
    </PageCard>
  )
}

export default function VestingPage() {
  const { selectedTreasury } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const form = useForm<VestingFormValues>({
    resolver: zodResolver(vestingFormSchema),
    defaultValues: {
      vesting: {
        address: "",
        amount: "",
        memo: "",
        startDate: undefined,
        cliffDate: undefined,
        endDate: undefined,
        allowCancel: false,
        allowEarn: false,
        token: NEAR_TOKEN
      },
      approveWithMyVote: false,
    },
  });

  const onSubmit = async (data: VestingFormValues) => {
    setIsSubmitting(true);
    try {
      const description = {
        title: `Create vesting schedule for ${data.vesting.address}`,
        notes: data.vesting.memo || "",
      }
      const proposalBond = policy?.proposal_bond || "0";
      const deposit = Big(data.vesting.amount)
        .mul(Big(10).pow(data.vesting.token.decimals))
        .toFixed();
      const vestingArgs = data.vesting.allowCancel
        ? {
          vesting_schedule: {
            VestingSchedule: {
              cliff_timestamp: formatTimestamp(data.vesting.cliffDate || data.vesting.startDate).toString(),
              end_timestamp: formatTimestamp(data.vesting.endDate).toString(),
              start_timestamp: formatTimestamp(data.vesting.startDate).toString(),
            },
          },
        }
        : {
          lockup_timestamp: formatTimestamp(data.vesting.startDate).toString(),
          release_duration: (
            formatTimestamp(data.vesting.endDate) - formatTimestamp(data.vesting.startDate)
          ).toString(),
        };

      const cancellableArgs = data.vesting.allowCancel ? {
        foundation_account_id: selectedTreasury!,
      } : {};
      const stakingArgs = !data.vesting.allowEarn ? {
        whitelist_account_id: LOCKUP_NO_WHITELIST_ACCOUNT_ID,
      } : {};

      await createProposal({
        treasuryId: selectedTreasury!,
        proposal: {
          description: encodeToMarkdown(description),
          kind: {
            FunctionCall: {
              receiver_id: "lockup.near",
              actions: [
                {
                  method_name: "create",
                  args: toBase64({
                    lockup_duration: "0",
                    owner_account_id: data.vesting.address,
                    ...vestingArgs,
                    ...cancellableArgs,
                    ...stakingArgs,
                  }),
                  deposit,
                  gas: "150000000000000",
                },
              ],
            },
          },
        },
        proposalBond,
      });
    } catch (error) {
      console.error("Vesting error", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <PageComponentLayout title="Vesting" description="Create vesting schedules quickly and effortlessly">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 max-w-[600px] mx-auto">
          <StepWizard
            stepTitles={["Details", "Settings", "Review"]}
            steps={[
              {
                nextButton: ({ handleNext }) => StepperNextButton({ text: "Continue" })(() => {
                  form.trigger(["vesting.address", "vesting.startDate", "vesting.endDate", "vesting.amount"]).then((isValid) => {
                    if (isValid) {
                      return handleNext();
                    }
                  });
                }),
                component: Step1,
              },
              {
                nextButton: ({ handleNext }) => StepperNextButton({ text: "Review Request" })(() => {
                  form.trigger().then((isValid) => {
                    if (isValid) {
                      return handleNext();
                    }
                  });
                }),
                component: Step2,
              },
              {
                nextButton: ({ }) => StepperNextButton({ text: "Confirm and Submit Request", loading: isSubmitting })(),
                component: Step3,
              }
            ]}
          />
        </form>
      </Form>
    </PageComponentLayout>
  );
}
