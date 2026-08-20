"use client";

import { Icon } from "@/components/icon";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { Input } from "@/components/input";
import { Label } from "@/components/ui/label";
import { useEffect, useMemo, useState } from "react";
import { PageCard } from "@/components/card";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import {
    Tabs,
    TabsList,
    TabsTrigger,
    TabsContent,
} from "@/components/underline-tabs";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import {
    Form,
    FormField,
    FormControl,
    FormItem,
    FormMessage,
} from "@/components/ui/form";
import { useNear } from "@/stores/near-store";
import { hasPermission } from "@/lib/config-utils";
import { MemberAvatarsWithOverflow } from "./member-avatars-with-overflow";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { encodeToMarkdown } from "@/lib/utils";
import { ThresholdSlider } from "@/components/threshold";
import { CreateRequestButton } from "@/components/create-request-button";
import { useProposals } from "@/hooks/use-proposals";
import { Button } from "@/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { RoleName } from "@/components/role-name";
import { WarningAlert } from "@/components/warning-alert";
import { NumberBadge } from "@/components/number-badge";

type VotingFormValues = {
    voteDuration: string;
    thresholds: Record<string, number>;
};

const proposalKinds = [
    "config",
    "policy",
    "add_bounty",
    "bounty_done",
    "transfer",
    "vote",
    "remove_member_from_role",
    "add_member_to_role",
    "call",
    "upgrade_self",
    "upgrade_remote",
    "set_vote_token",
];

interface VotingRequestActionProps {
    hasPendingRequest: boolean;
    onCreateRequest: () => void;
    isSubmitting: boolean;
    disabled: boolean;
}

function VotingRequestAction({
    hasPendingRequest,
    onCreateRequest,
    isSubmitting,
    disabled,
}: VotingRequestActionProps) {
    return (
        <div className="rounded-lg border bg-card p-0 overflow-hidden">
            <CreateRequestButton
                onClick={onCreateRequest}
                isSubmitting={isSubmitting}
                permissions={{ kind: "policy", action: "AddProposal" }}
                disabled={disabled || hasPendingRequest}
                className="w-full h-10 rounded-none"
            />
        </div>
    );
}

export function VotingTab() {
    const t = useTranslations("settings.voting");
    const votingFormSchema = useMemo(
        () =>
            z.object({
                voteDuration: z
                    .string()
                    .min(1, t("validation.required"))
                    .refine((val) => !isNaN(Number(val)), {
                        message: t("validation.validNumber"),
                    })
                    .refine((val) => Number(val) >= 1, {
                        message: t("validation.min"),
                    })
                    .refine((val) => Number(val) < 1000, {
                        message: t("validation.max"),
                    })
                    .refine((val) => Number.isInteger(Number(val)), {
                        message: t("validation.whole"),
                    }),
                thresholds: z.record(z.string(), z.number()),
            }),
        [t],
    );
    const { treasuryId } = useTreasury();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { accountId, createProposal } = useNear();
    const queryClient = useQueryClient();
    const router = useRouter();

    // Fetch pending proposals to check for active voting change requests
    const { data: pendingProposals } = useProposals(treasuryId, {
        statuses: ["InProgress"],
        proposal_types: ["ChangePolicy", "ChangePolicyUpdateParameters"],
    });

    // Check for specific pending proposal types
    const hasPendingVotingRequest = useMemo(() => {
        if (!pendingProposals?.proposals) return false;
        return pendingProposals.proposals.some(
            (p) =>
                p.kind &&
                ("ChangePolicy" in p.kind ||
                    "ChangePolicyUpdateParameters" in p.kind),
        );
    }, [pendingProposals]);

    const form = useForm<VotingFormValues>({
        resolver: zodResolver(votingFormSchema),
        mode: "onChange",
        defaultValues: {
            voteDuration: "7",
            thresholds: {},
        },
    });

    const [activeTab, setActiveTab] = useState<string>("");
    const [originalDuration, setOriginalDuration] = useState<string>("");
    const [originalThresholds, setOriginalThresholds] = useState<
        Record<string, number>
    >({});
    const [isSubmittingThreshold, setIsSubmittingThreshold] = useState(false);
    const [isSubmittingDuration, setIsSubmittingDuration] = useState(false);

    // Check if user is authorized to make policy changes
    const isAuthorized = useMemo(() => {
        if (!policy || !accountId) return false;
        return hasPermission(policy, accountId, "policy", "AddProposal");
    }, [policy, accountId]);

    // Get roles with Group kind (filter out Everyone and Member)
    const groupRoles = useMemo(() => {
        if (!policy?.roles) return [];

        return policy.roles
            .filter((role) => {
                if (role.kind === "Everyone") return false;

                // Filter out specific role names
                const roleName = role.name.toLowerCase();
                if (
                    roleName === "create requests" ||
                    roleName === "requestor" ||
                    roleName === "all"
                ) {
                    return false;
                }

                return true;
            })
            .map((role) => {
                // Get the first available vote policy key, or use default
                const firstPolicyKey = Object.keys(role.vote_policy)[0];
                const votePolicy = firstPolicyKey
                    ? role.vote_policy[firstPolicyKey]
                    : policy.default_vote_policy;

                const members = (
                    typeof role.kind === "object" && "Group" in role.kind
                        ? role.kind.Group
                        : []
                ) as string[];
                const memberCount = members.length;

                // Calculate threshold for THIS specific role
                let threshold = 1;
                if (votePolicy.weight_kind === "RoleWeight") {
                    if (Array.isArray(votePolicy.threshold)) {
                        // It's a ratio array: [numerator, denominator]
                        const [numerator, denominator] = votePolicy.threshold;
                        if (denominator > 0) {
                            threshold = Math.ceil(
                                (numerator / denominator) * memberCount,
                            );
                        }
                    } else if (typeof votePolicy.threshold === "string") {
                        // It's a direct number as string (U128)
                        threshold = parseFloat(votePolicy.threshold);
                    }
                }

                threshold = Math.max(1, threshold || 1);
                return {
                    name: role.name,
                    members,
                    votePolicy,
                    threshold,
                    memberCount,
                };
            });
    }, [policy]);

    // Initialize form with policy data
    useEffect(() => {
        if (policy?.proposal_period && groupRoles.length > 0) {
            const nanoseconds = BigInt(policy.proposal_period);
            const days = Number(nanoseconds / BigInt(86400000000000)); // ns to days

            // Initialize thresholds for each role
            const initialThresholds: Record<string, number> = {};
            groupRoles.forEach((role) => {
                initialThresholds[role.name] = role.threshold;
            });

            setOriginalDuration(days.toString());

            form.reset({
                voteDuration: days.toString(),
                thresholds: initialThresholds,
            });

            // Save original thresholds for comparison
            setOriginalThresholds(initialThresholds);

            // Set initial active tab
            setActiveTab(groupRoles[0].name);
        }
    }, [policy, groupRoles, form]);

    // Check if we have specific roles for custom description
    const hasApproversAndGovernance = useMemo(() => {
        const roleNames = groupRoles.map((role) => role.name.toLowerCase());
        return (
            roleNames.includes("approvers") && roleNames.includes("governance")
        );
    }, [groupRoles]);

    const thresholdDescription = hasApproversAndGovernance
        ? t("thresholdDescriptionApprovers")
        : t("thresholdDescriptionGeneric");

    const handleThresholdChange = async () => {
        if (!treasuryId || !policy || !activeTab) {
            toast.error(t("missingData"));
            return;
        }

        setIsSubmittingThreshold(true);
        try {
            const thresholds = form.watch("thresholds");
            const newThreshold = thresholds[activeTab];

            const description = {
                title: t("thresholdProposalTitle"),
                summary: t("thresholdProposalSummary", {
                    account: accountId ?? "",
                    oldValue: originalThresholds[activeTab],
                    newValue: newThreshold,
                }),
            };

            const proposalBond = policy?.proposal_bond || "0";

            await createProposal(t("thresholdSubmitted"), {
                treasuryId: treasuryId,
                proposal: {
                    description: encodeToMarkdown(description),
                    kind: {
                        ChangePolicy: {
                            policy: {
                                ...policy,
                                roles: policy.roles?.map((role) => {
                                    if (role.name === activeTab) {
                                        const vote_policy =
                                            proposalKinds.reduce(
                                                (
                                                    policy: Record<string, any>,
                                                    kind: string,
                                                ) => {
                                                    (
                                                        policy as Record<
                                                            string,
                                                            any
                                                        >
                                                    )[kind] = {
                                                        weight_kind:
                                                            "RoleWeight",
                                                        quorum: "0",
                                                        threshold:
                                                            newThreshold.toString(),
                                                    };
                                                    return policy;
                                                },
                                                {},
                                            );
                                        return {
                                            ...role,
                                            vote_policy,
                                        };
                                    }
                                    return role;
                                }),
                            },
                        },
                    },
                },
                proposalBond: proposalBond,
                proposalType: "other",
            });

            // Refetch proposals to show the newly created proposal
            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });

            // Update original thresholds
            setOriginalThresholds((prev) => ({
                ...prev,
                [activeTab]: newThreshold,
            }));
        } catch (error) {
            console.error("Error creating proposal:", error);
            toast.error(t("createProposalFailed"));
        } finally {
            setIsSubmittingThreshold(false);
        }
    };

    const handleDurationChange = async () => {
        if (!treasuryId || !policy) {
            toast.error(t("missingData"));
            return;
        }

        // Validate the vote duration field
        const isValid = await form.trigger("voteDuration");
        if (!isValid) {
            return;
        }

        setIsSubmittingDuration(true);
        try {
            const voteDuration = form.watch("voteDuration");
            const durationInNanoseconds =
                Number(voteDuration) * 24 * 60 * 60 * 1_000_000_000;

            const description = {
                title: t("durationProposalTitle"),
                summary: t("durationProposalSummary", {
                    account: accountId ?? "",
                    oldValue: originalDuration,
                    newValue: voteDuration,
                }),
            };

            const proposalBond = policy?.proposal_bond || "0";

            await createProposal(t("durationSubmitted"), {
                treasuryId: treasuryId,
                proposal: {
                    description: encodeToMarkdown(description),
                    kind: {
                        ChangePolicyUpdateParameters: {
                            parameters: {
                                proposal_period:
                                    durationInNanoseconds.toString(),
                            },
                        },
                    },
                },
                proposalBond: proposalBond,
                proposalType: "other",
            });

            // Refetch proposals to show the newly created proposal
            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });

            // Mark as not dirty
            form.reset(form.getValues());
        } catch (error) {
            console.error("Error creating proposal:", error);
        } finally {
            setIsSubmittingDuration(false);
        }
    };

    return (
        <Form {...form}>
            <div className="space-y-6">
                {hasPendingVotingRequest && (
                    <PageCard className="space-y-2">
                        <WarningAlert
                            message={
                                <>
                                    <h4 className="font-semibold mb-1">
                                        {t("pendingTitle")}
                                    </h4>
                                    <p className="text-sm">
                                        {t("pendingBody")}
                                    </p>
                                </>
                            }
                        />

                        <Button
                            onClick={() =>
                                router.push(
                                    `/${treasuryId}/requests?tab=InProgress`,
                                )
                            }
                            variant="default"
                            className="w-full"
                        >
                            {t("viewRequest")}
                            <Icon icon={ArrowUpRight01Icon} />
                        </Button>
                    </PageCard>
                )}

                <PageCard>
                    <div>
                        <h3 className="text-lg font-semibold">
                            {t("thresholdHeading")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {thresholdDescription}
                        </p>
                    </div>

                    <Tabs value={activeTab} onValueChange={setActiveTab}>
                        <TabsList>
                            {groupRoles.map((role) => (
                                <TabsTrigger key={role.name} value={role.name}>
                                    <RoleName name={role.name} />
                                </TabsTrigger>
                            ))}
                        </TabsList>

                        {groupRoles.map((role) => (
                            <TabsContent key={role.name} value={role.name}>
                                <div className="space-y-4">
                                    <div className="flex flex-col gap-1">
                                        {/* Members who can vote */}
                                        <div className="flex items-center gap-2">
                                            <span className="text-sm font-medium">
                                                {t("membersWhoCanVote")}
                                            </span>
                                            <NumberBadge
                                                number={role.memberCount}
                                                variant="accent"
                                                sizes="sm"
                                            />
                                        </div>

                                        {/* Member avatars */}
                                        <MemberAvatarsWithOverflow
                                            members={role.members}
                                            totalCount={role.memberCount}
                                        />
                                    </div>

                                    {/* Threshold slider */}
                                    {(() => {
                                        const thresholds =
                                            form.watch("thresholds");
                                        const currentThreshold =
                                            thresholds?.[role.name] ??
                                            role.threshold;

                                        return (
                                            <div className="flex flex-col gap-1">
                                                <p className="text-sm font-medium text-foreground">
                                                    {t("votesRequired")}
                                                </p>
                                                <ThresholdSlider
                                                    currentThreshold={
                                                        currentThreshold
                                                    }
                                                    originalThreshold={
                                                        originalThresholds[
                                                            role.name
                                                        ]
                                                    }
                                                    memberCount={
                                                        role.memberCount
                                                    }
                                                    onValueChange={(value) => {
                                                        form.setValue(
                                                            "thresholds",
                                                            {
                                                                ...thresholds,
                                                                [role.name]:
                                                                    value,
                                                            },
                                                            {
                                                                shouldDirty: true,
                                                            },
                                                        );
                                                    }}
                                                    disabled={
                                                        !isAuthorized ||
                                                        hasPendingVotingRequest
                                                    }
                                                />
                                            </div>
                                        );
                                    })()}
                                </div>
                            </TabsContent>
                        ))}
                    </Tabs>

                    <VotingRequestAction
                        hasPendingRequest={hasPendingVotingRequest}
                        onCreateRequest={handleThresholdChange}
                        isSubmitting={isSubmittingThreshold}
                        disabled={
                            !activeTab ||
                            !form.watch("thresholds")?.[activeTab] ||
                            form.watch("thresholds")[activeTab] ===
                                originalThresholds[activeTab]
                        }
                    />
                </PageCard>

                <PageCard>
                    <div>
                        <h3 className="text-lg font-semibold">
                            {t("durationHeading")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("durationDescription")}
                            {hasApproversAndGovernance
                                ? t("durationApprovers")
                                : t("durationGeneric")}
                        </p>
                    </div>

                    <FormField
                        control={form.control}
                        name="voteDuration"
                        render={({ field }) => (
                            <FormItem>
                                <Label htmlFor="vote-duration">
                                    {t("days")}
                                </Label>
                                <FormControl>
                                    <Input
                                        id="vote-duration"
                                        type="number"
                                        min="1"
                                        max="999"
                                        clearable={false}
                                        step="1"
                                        disabled={
                                            !isAuthorized ||
                                            hasPendingVotingRequest
                                        }
                                        {...field}
                                    />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />

                    <VotingRequestAction
                        hasPendingRequest={hasPendingVotingRequest}
                        onCreateRequest={handleDurationChange}
                        isSubmitting={isSubmittingDuration}
                        disabled={
                            !form.formState.dirtyFields.voteDuration ||
                            !!form.formState.errors.voteDuration
                        }
                    />
                </PageCard>
            </div>
        </Form>
    );
}
