"use client";

import { PageCard } from "@/components/card";
import { CheckboxInput } from "@/components/checkbox-input";
import { DateInput } from "@/components/date-input";
import { InfoDisplay } from "@/components/info-display";
import { InputBlock } from "@/components/input-block";
import { PageComponentLayout } from "@/components/page-component-layout";
import { RecipientInput } from "@/components/recipient-input";
import { ReviewStep, StepperHeader, InlineNextButton, StepProps, StepWizard } from "@/components/step-wizard";
import { TokenInput, tokenSchema } from "@/components/token-input";
import { Form, FormField } from "@/components/ui/form";
import { Textarea } from "@/components/textarea";
import { NEAR_TOKEN } from "@/constants/token";
import { useToken, useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { encodeToMarkdown, formatUserDate, formatTimestamp, toBase64, formatCurrency } from "@/lib/utils";
import { useFormatDate } from "@/components/formatted-date";
import { useNear } from "@/stores/near-store";
import { useTreasury } from "@/hooks/use-treasury";
import { zodResolver } from "@hookform/resolvers/zod";
import Big from "big.js";
import { useMemo, useState } from "react";
import { useForm, useFormContext } from "react-hook-form";
import z from "zod";
import { LOCKUP_NO_WHITELIST_ACCOUNT_ID } from "@/constants/config";
import { SendingTotal } from "@/components/sending-total";
import { CreateRequestButton } from "@/components/create-request-button";

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
        message: `Cliff date must be between ${formatUserDate(data.vesting.startDate, { includeTime: false })} and ${formatUserDate(data.vesting.endDate, { includeTime: false })}`,
      });
    }

  }
});

type VestingFormValues = z.infer<typeof vestingFormSchema>;

function Step1({ handleNext }: StepProps) {
  const form = useFormContext<VestingFormValues>();
  const startDate = form.watch("vesting.startDate");
  const endDate = form.watch("vesting.endDate");

  const handleContinue = () => {
    form.trigger(["vesting.address", "vesting.startDate", "vesting.endDate", "vesting.amount"]).then((isValid) => {
      if (isValid && handleNext) {
        handleNext();
      }
    });
  };

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

      <CreateRequestButton
        onClick={handleContinue}
        permissions={{ kind: "call", action: "AddProposal" }}
        idleMessage="Continue"
      />
    </PageCard>)
}

function Step2({ handleBack, handleNext }: StepProps) {
  const form = useFormContext<VestingFormValues>();
  const allowCancel = form.watch("vesting.allowCancel");
  const startDate = form.watch("vesting.startDate");
  const endDate = form.watch("vesting.endDate");

  const handleReview = () => {
    form.trigger().then((isValid) => {
      if (isValid && handleNext) {
        handleNext();
      }
    });
  };

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

      <div className="rounded-lg border bg-card p-0 overflow-hidden">
        <CreateRequestButton
          onClick={handleReview}
          className="w-full h-10 rounded-none"
          permissions={{ kind: "call", action: "AddProposal" }}
          idleMessage="Review Request"
        />
      </div>
    </PageCard>
  )
}

function Step3({ handleBack }: StepProps) {
  const form = useFormContext<VestingFormValues>();
  const { vesting } = form.watch();
  const { data: token } = useToken(vesting.token.address);
  const formatDate = useFormatDate();

  const estimatedUSDValue = useMemo(() => {
    if (!token?.price || !vesting.amount || isNaN(Number(vesting.amount))) {
      return 0;
    }
    return Number(vesting.amount) * token.price;
  }, [token?.price, vesting.amount]);

  const infoItems = useMemo(() => {
    let items = [
      {
        label: "Recipient",
        value: vesting.address,
      },
      {
        label: "Start Date",
        value: formatDate(vesting.startDate, { includeTime: false }),
      },
      {
        label: "End Date",
        value: formatDate(vesting.endDate, { includeTime: false }),
      },
      {
        label: "Cliff Date",
        value: vesting.cliffDate ? formatDate(vesting.cliffDate, { includeTime: false }) : "N/A",
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
  }, [vesting, formatDate]);

  return (
    <PageCard>
      <ReviewStep reviewingTitle="Review Your Vesting Schedule" handleBack={handleBack}>
        <div className="flex flex-col gap-6">
          <SendingTotal total={Number(vesting.amount)} token={vesting.token}>
            <p>≈ {formatCurrency(estimatedUSDValue)}</p>
          </SendingTotal>
          <InfoDisplay items={infoItems} />
        </div>
      </ReviewStep>

      <CreateRequestButton
        isSubmitting={form.formState.isSubmitting}
        type="submit"
        className="w-full h-10 rounded-none"
        permissions={{ kind: "call", action: "AddProposal" }}
        idleMessage="Confirm and Submit Request"
      />
    </PageCard>
  )
}

export default function VestingPage() {
  const { treasuryId } = useTreasury();
  const { createProposal } = useNear();
  const { data: policy } = useTreasuryPolicy(treasuryId);
  const [step, setStep] = useState(0);

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
    },
  });

  const onSubmit = async (data: VestingFormValues) => {
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
      foundation_account_id: treasuryId!,
    } : {};
    const stakingArgs = !data.vesting.allowEarn ? {
      whitelist_account_id: LOCKUP_NO_WHITELIST_ACCOUNT_ID,
    } : {};

    await createProposal("Request to create vesting schedule submitted", {
      treasuryId: treasuryId!,
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
    }).then(() => {
      form.reset();
      setStep(0);
    }).catch((error) => {
      console.error("Vesting error", error);
    });
  };

  return (
    <PageComponentLayout title="Vesting" description="Create vesting schedules quickly and effortlessly">
      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 max-w-[600px] mx-auto">
          <StepWizard
            step={step}
            onStepChange={setStep}
            stepTitles={["Details", "Settings", "Review"]}
            steps={[
              {
                component: Step1,
              },
              {
                component: Step2,
              },
              {
                component: Step3,
              }
            ]}
          />
        </form>
      </Form>
    </PageComponentLayout>
  );
}
