"use client";

import { PageCard } from "@/components/card";
import { InputBlock } from "@/components/input-block";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepperHeader, StepProps, StepWizard, InlineNextButton } from "@/components/step-wizard";
import { Form, FormField, FormMessage } from "@/components/ui/form";
import { LargeInput } from "@/components/large-input";
import { zodResolver } from "@hookform/resolvers/zod";
import { useEffect, } from "react";
import { ArrayPath, useForm, useFormContext } from "react-hook-form";
import z from "zod";
import { checkHandleUnused, createTreasury, CreateTreasuryRequest } from "@/lib/api";
import { Member, MemberInput, memberSchema } from "@/components/member-input";
import { useNear } from "@/stores/near-store";
import { ThresholdSlider } from "@/components/threshold";
import { CircleCheck, Database, Info, UsersRound, Vote } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

const treasuryFormSchema = z.object({
    details: z.object({
        treasuryName: z.string().min(2, "Treasury name should be at least 2 characters").max(64, "Treasury name must be less than 64 characters"),
        accountName: z.string()
            .min(2, "Account name should be at least 2 characters")
            .max(64, "Account name must be less than 64 characters")
            .regex(/^[a-z0-9-]+$/, "Account name can only contain lowercase letters, numbers, and hyphens"),
        paymentThreshold: z.number().min(1).max(100),
    }).refine(
        async (data) => {
            if (!data.accountName) return true;
            const fullAccountId = `${data.accountName}.sputnik-dao.near`;
            const result = await checkHandleUnused(fullAccountId);
            return result?.unused === true;
        },
        {
            message: "This account name is already taken",
            path: ["accountName"],
        }
    ),
    members: memberSchema,
}).refine(
    (data) => {
        const financialMembers = data.members.filter(m => m.roles.includes("financial")).length;
        return data.details.paymentThreshold <= financialMembers;
    }
);

type TreasuryFormValues = z.infer<typeof treasuryFormSchema>;

function Step1({ handleNext }: StepProps) {
    const form = useFormContext<TreasuryFormValues>();

    const handleContinue = async () => {
        const isValid = await form.trigger(["details.treasuryName", "details.accountName"]);
        if (isValid && handleNext) {
            handleNext();
        }
    };

    return (
        <PageCard>
            <StepperHeader title="Create a Treasury" />

            <FormField control={form.control} name="details.treasuryName" render={({ field, fieldState }) => (
                <InputBlock title="Treasury Name" invalid={!!fieldState.error}>
                    <LargeInput
                        borderless
                        placeholder="My Treasury"
                        value={field.value}
                        onChange={(e) => {
                            field.onChange(e);
                            const generatedHandle = e.target.value
                                .toLowerCase()
                                .replace(/[^a-z0-9-]/g, "-")
                                .replace(/-+/g, "-")
                                .replace(/^-|-$/g, "")
                                .slice(0, 64);
                            if (generatedHandle !== field.value) {
                                form.setValue("details.accountName", generatedHandle);
                            }
                        }}
                    />
                    {fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Error placeholder</p>}
                </InputBlock>
            )} />

            <FormField control={form.control} name="details.accountName" render={({ field, fieldState }) => (
                <InputBlock title="Account Name" info="This is your account’s unique name. It will be used in your Treasury URL and shown in transactions to identify who sent the payment. Choose a short, recognizable name for your account." invalid={!!fieldState.error}>
                    <LargeInput
                        borderless
                        placeholder="my-treasury"
                        suffix=".sputnik-dao.near"
                        value={field.value}
                        onChange={(e) => {
                            const input = e.target.value
                                .toLowerCase()
                                .replace(/[^a-z0-9_-]/g, "")
                                .slice(0, 64);
                            field.onChange(input);
                        }}
                    />
                    {fieldState.error ? <FormMessage /> : <p className="text-muted-foreground text-xs invisible">Error placeholder</p>}
                </InputBlock>
            )} />

            <InlineNextButton text="Continue" onClick={handleContinue} />
        </PageCard>
    );
}

function Step2({ handleBack, handleNext }: StepProps) {
    const form = useFormContext<TreasuryFormValues>();

    const handleReview = async () => {
        const isValid = await form.trigger(["members"]);
        if (isValid && handleNext) {
            handleNext();
        }
    };

    const { members } = form.watch();
    const financialMembers = members.filter((m: Member) => m.roles.includes("financial")).length;

    return (
        <PageCard>
            <StepperHeader title="Add Members" description="You can add or update members now and edit this later at any time." handleBack={handleBack} />

            <div className="flex flex-col gap-8">
                <MemberInput control={form.control} lockedFirstMember={true} name={`members` as ArrayPath<TreasuryFormValues>} />

                <div className="flex flex-col gap-4">
                    <div className="flex flex-col gap-1">
                        <h3 className="font-semibold">Payment-Related Voting Threshold</h3>
                        <p className="text-sm text-muted-foreground">Select how many Financial votes are required to approve payment-related requests. This setting can be changed at any time.</p>
                    </div>
                    <FormField control={form.control} name="details.paymentThreshold" render={({ field }) => (
                        <ThresholdSlider currentThreshold={field.value} memberCount={financialMembers} onValueChange={field.onChange} />
                    )} />
                </div>
                <InlineNextButton text="Review Treasury" onClick={handleReview} />
            </div>
        </PageCard>
    );
}

const VISUAL = [
    {
        "icon": <UsersRound className="size-5 text-primary" />,
        "title": "Members",
    },
    {
        "icon": <Vote className="size-5 text-primary" />,
        "title": "Threshold",
    }
] as const;

function Step3({ handleBack }: StepProps) {
    const form = useFormContext<TreasuryFormValues>();
    const { details } = form.watch();
    const { members } = form.watch();
    const financialMembers = members.filter((m: Member) => m.roles.includes("financial")).length;
    const threshold = details.paymentThreshold;
    const thresholdVisual = `${threshold}/${financialMembers}`;

    return (
        <PageCard>
            <StepperHeader title="Review Treasury" handleBack={handleBack} />

            <div className="flex flex-col gap-2">
                <InputBlock invalid={false}>
                    <div className="flex gap-3.5 px-3.5 py-3 items-center">
                        <div className="size-10 rounded-[7px] bg-primary/10 flex items-center justify-center">
                            <Database className="size-5 text-primary" />
                        </div>
                        <div className="flex flex-col gap-0.5">
                            <p className="font-bold text-2xl">{details.treasuryName}</p>
                            <p className="text-xs text-muted-foreground">{details.accountName}.sputnik-dao.near</p>
                        </div>
                    </div>
                </InputBlock>
                <div className="grid md:grid-cols-3 grid-cols-1 gap-2">
                    {[members.length, thresholdVisual].map((item, index) => (
                        <InputBlock invalid={false} key={index}>
                            <div className="flex flex-col px-3.5 py-3 gap-1 items-center justify-center">
                                {VISUAL[index].icon}
                                <p className="font-semibold text-xl">{item}</p>
                                <p className="text-xs text-muted-foreground">{VISUAL[index].title}</p>
                            </div>
                        </InputBlock>
                    ))}

                    <InputBlock invalid={false}>
                        <div className="flex flex-col gap-1 items-center justify-center">
                            <CircleCheck className="size-5 text-general-success-foreground" />
                            <p className="font-semibold text-xl text-muted-foreground"><span className="line-through">~0.25</span> <span className="text-general-success-foreground">Free</span></p>
                            <p className="text-xs text-muted-foreground">Deployment Fee</p>
                            <p className="text-xs font-medium text-general-success-foreground">Sponsored by TREASURY</p>
                        </div>
                    </InputBlock>
                </div>

            </div>

            <Alert variant="info">
                <Info />
                <AlertDescription className="inline-block text-general-info-foreground">
                    To support new projects, <span className="font-semibold">TREASURY</span> is sponsoring the one-time platform and network storage fees for your Treasury deployment on the NEAR protocol.
                </AlertDescription>
            </Alert>

            <InlineNextButton text="Create Treasury" loading={form.formState.isSubmitting} />
        </PageCard>
    );
}

export default function NewTreasuryPage() {
    const { accountId, isInitializing } = useNear();
    const router = useRouter();
    const form = useForm<TreasuryFormValues>({
        resolver: zodResolver(treasuryFormSchema),
        defaultValues: {
            details: {
                paymentThreshold: 1,
                treasuryName: "",
                accountName: "",
            },
            members: [
                {
                    accountId: "",
                    roles: ["governance", "requestor", "financial"],
                },
            ],
        },
    });
    useEffect(() => {
        if (accountId) {
            form.setValue("members.0.accountId", accountId);
        }
    }, [accountId]);

    useEffect(() => {
        if (!isInitializing && !accountId) {
            router.push("/app/");
        }
    }, [accountId, isInitializing]);

    const onSubmit = async (data: TreasuryFormValues) => {
        try {
            // Extract unique account IDs for each role
            const governors = data.members
                .filter(m => m.roles.includes("governance"))
                .map(m => m.accountId);
            const financiers = data.members
                .filter(m => m.roles.includes("financial"))
                .map(m => m.accountId);
            const requestors = data.members
                .filter(m => m.roles.includes("requestor"))
                .map(m => m.accountId);

            const request: CreateTreasuryRequest = {
                name: data.details.treasuryName,
                accountId: `${data.details.accountName}.sputnik-dao.near`,
                paymentThreshold: data.details.paymentThreshold,
                governors,
                financiers,
                requestors,
            };

            await createTreasury(request).then((response) => {
                toast.success("Treasury created successfully");
                router.push(`/app/${response.treasury}`);
            }).catch((error) => {
                console.error("Treasury creation error", error);
                toast.error("Failed to create treasury");
            });
        } catch (error) {
            console.error("Treasury creation error", error);
            toast.error("Failed to create treasury");
        }
    };

    return (
        <PageComponentLayout
            title="Create Treasury"
            description="Set up a new multisig treasury for your team"
            backButton="/"
        >
            <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4 max-w-[600px] mx-auto">
                    <StepWizard
                        stepTitles={["Details", "Members", "Review"]}
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
