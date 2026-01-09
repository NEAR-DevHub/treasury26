"use client";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useEffect, useMemo, useState } from "react";
import { PageCard } from "@/components/card";
import { useTreasury } from "@/stores/treasury-store";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
  TabsContents,
} from "@/components/underline-tabs";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { config, z } from "zod";
import {
  Form,
  FormField,
  FormControl,
  FormItem,
  FormMessage,
} from "@/components/ui/form";
import { useNear } from "@/stores/near-store";
import { hasPermission } from "@/lib/config-utils";
import { User } from "@/components/user";
import { toast } from "sonner";
import { useRouter } from "next/navigation";
import { encodeToMarkdown } from "@/lib/utils";
import { ThresholdSlider } from "@/components/threshold";
import { CreateRequestButton } from "@/components/create-request-button";
import { useProposals } from "@/hooks/use-proposals";
import { ArrowUpRight } from "lucide-react";
import { Button } from "@/components/button";
import { useQueryClient } from "@tanstack/react-query";
import { RoleName } from "@/components/role-name";
import { WarningAlert } from "@/components/warning-alert";

const votingFormSchema = z.object({
  voteDuration: z
    .string()
    .min(1, "Vote duration is required")
    .refine((val) => !isNaN(Number(val)), {
      message: "Vote duration must be a valid number",
    })
    .refine((val) => Number(val) >= 1, {
      message: "Vote duration must be at least 1 day",
    })
    .refine((val) => Number(val) < 1000, {
      message: "Vote duration must be less than 1000 days",
    })
    .refine((val) => Number.isInteger(Number(val)), {
      message: "Vote duration must be a whole day",
    }),
  thresholds: z.record(z.string(), z.number()),
});

type VotingFormValues = z.infer<typeof votingFormSchema>;

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
  isAuthorized: boolean;
  accountId: string | null;
  disabled: boolean;
  permissionMessage: string;
}

function VotingRequestAction({
  hasPendingRequest,
  onCreateRequest,
  isSubmitting,
  isAuthorized,
  accountId,
  disabled,
  permissionMessage,
}: VotingRequestActionProps) {
  return (
    <div className="rounded-lg border bg-card p-0 overflow-hidden">
      <CreateRequestButton
        onClick={onCreateRequest}
        isSubmitting={isSubmitting}
        isAuthorized={isAuthorized}
        accountId={accountId}
        disabled={disabled || hasPendingRequest}
        permissionMessage={permissionMessage}
        className="w-full h-10 rounded-none"
      />
    </div>
  );
}

export function VotingTab() {
  const { selectedTreasury } = useTreasury();
  const { data: policy } = useTreasuryPolicy(selectedTreasury);
  const { accountId, createProposal } = useNear();
  const queryClient = useQueryClient();
  const router = useRouter();

  // Fetch pending proposals to check for active voting change requests
  const { data: pendingProposals } = useProposals(selectedTreasury, {
    statuses: ["InProgress"],
    proposal_types: ["ChangePolicy", "ChangePolicyUpdateParameters"],
  });

  // Check for specific pending proposal types
  const hasPendingVotingRequest = useMemo(() => {
    if (!pendingProposals?.proposals) return false;
    return pendingProposals.proposals.some(
      (p) =>
        p.kind &&
        ("ChangePolicy" in p.kind || "ChangePolicyUpdateParameters" in p.kind)
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
              threshold = Math.ceil((numerator / denominator) * memberCount);
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
    return roleNames.includes("approvers") && roleNames.includes("governance");
  }, [groupRoles]);

  const thresholdDescription = hasApproversAndGovernance
    ? "Define how many votes are required to approve payment and team-related requests. Configure thresholds separately for Approvers and Governance."
    : "Define how many votes are required to approve requests. Configure thresholds for each role based on their responsibilities.";

  const handleThresholdChange = async () => {
    if (!selectedTreasury || !policy || !activeTab) {
      toast.error("Missing required data");
      return;
    }

    setIsSubmittingThreshold(true);
    try {
      const thresholds = form.watch("thresholds");
      const newThreshold = thresholds[activeTab];

      const description = {
        title: "Update policy - Voting Thresholds",
        summary: `${accountId} requested to change voting threshold from ${originalThresholds[activeTab]} to ${newThreshold}.`,
      };

      const proposalBond = policy?.proposal_bond || "0";

      await createProposal("Request to update voting threshold submitted", {
        treasuryId: selectedTreasury,
        proposal: {
          description: encodeToMarkdown(description),
          kind: {
            ChangePolicy: {
              policy: {
                ...policy,
                roles: policy.roles?.map((role) => {
                  if (role.name === activeTab) {
                    const vote_policy = proposalKinds.reduce(
                      (policy: Record<string, any>, kind: string) => {
                        (policy as Record<string, any>)[kind] = {
                          weight_kind: "RoleWeight",
                          quorum: "0",
                          threshold: newThreshold.toString(),
                        };
                        return policy;
                      },
                      {}
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
      });

      // Refetch proposals to show the newly created proposal
      queryClient.invalidateQueries({
        queryKey: ["proposals", selectedTreasury],
      });

      // Update original thresholds
      setOriginalThresholds((prev) => ({
        ...prev,
        [activeTab]: newThreshold,
      }));
    } catch (error) {
      console.error("Error creating proposal:", error);
      toast.error("Failed to create proposal");
    } finally {
      setIsSubmittingThreshold(false);
    }
  };

  const handleDurationChange = async () => {
    if (!selectedTreasury || !policy) {
      toast.error("Missing required data");
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
        title: "Update policy - Voting Duration",
        summary: `${accountId} requested to change voting duration from ${originalDuration} to ${voteDuration}.`,
      };

      const proposalBond = policy?.proposal_bond || "0";

      await createProposal("Request created successfully", {
        treasuryId: selectedTreasury,
        proposal: {
          description: encodeToMarkdown(description),
          kind: {
            ChangePolicyUpdateParameters: {
              parameters: {
                proposal_period: durationInNanoseconds.toString(),
              },
            },
          },
        },
        proposalBond: proposalBond,
      });

      // Refetch proposals to show the newly created proposal
      queryClient.invalidateQueries({
        queryKey: ["proposals", selectedTreasury],
      });

      // Mark as not dirty
      form.reset(form.getValues());
    } catch (error) {
      console.error("Error creating proposal:", error);
      toast.error("Failed to create proposal");
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
                    Active Voting Threshold Request
                  </h4>
                  <p className="text-sm">
                    To avoid conflicts, you need to complete or resolve the
                    existing pending requests before proceeding. These requests
                    are currently active and must be approved or rejected first.
                  </p>
                </>
              }
            />

            <Button
              onClick={() =>
                router.push(`/${selectedTreasury}/requests?tab=pending`)
              }
              variant="default"
              className="w-full"
            >
              View Request
              <ArrowUpRight className="h-4 w-4" />
            </Button>
          </PageCard>
        )}

        <PageCard>
          <div>
            <h3 className="text-lg font-semibold">Voting Threshold</h3>
            <p className="text-sm text-muted-foreground">
              {thresholdDescription}
            </p>
          </div>

          <Tabs
            value={activeTab}
            onValueChange={setActiveTab}
            className="w-full"
          >
            <TabsList>
              {groupRoles.map((role) => (
                <TabsTrigger key={role.name} value={role.name}>
                  <RoleName name={role.name} />
                </TabsTrigger>
              ))}
            </TabsList>

            <TabsContents>
              {groupRoles.map((role) => (
                <TabsContent key={role.name} value={role.name}>
                  <div className="space-y-4">
                    {/* Members who can vote */}
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        Members who can vote
                      </span>
                      <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-sm">
                        {role.memberCount}
                      </span>
                    </div>

                    {/* Member avatars */}
                    <div className="flex items-center">
                      {role.members
                        .slice(0, 15)
                        .map((member: string, index: number) => (
                          <div key={member} className="-ml-2 first:ml-0">
                            <User
                              accountId={member}
                              iconOnly={true}
                              size="lg"
                              withLink={true}
                              withHoverCard={true}
                            />
                          </div>
                        ))}
                      {role.memberCount > 10 && (
                        <span className="ml-2 text-sm text-muted-foreground">
                          +{role.memberCount - 10} more
                        </span>
                      )}
                    </div>

                    {/* Threshold slider */}
                    {(() => {
                      const thresholds = form.watch("thresholds");
                      const currentThreshold =
                        thresholds?.[role.name] ?? role.threshold;

                      return (
                        <ThresholdSlider
                          currentThreshold={currentThreshold}
                          originalThreshold={originalThresholds[role.name]}
                          memberCount={role.memberCount}
                          onValueChange={(value) => {
                            form.setValue(
                              "thresholds",
                              {
                                ...thresholds,
                                [role.name]: value,
                              },
                              { shouldDirty: true }
                            );
                          }}
                          disabled={!isAuthorized || hasPendingVotingRequest}
                        />
                      );
                    })()}
                  </div>
                </TabsContent>
              ))}
            </TabsContents>
          </Tabs>

          <VotingRequestAction
            hasPendingRequest={hasPendingVotingRequest}
            onCreateRequest={handleThresholdChange}
            isSubmitting={isSubmittingThreshold}
            isAuthorized={isAuthorized}
            accountId={accountId}
            disabled={
              !activeTab ||
              !form.watch("thresholds")?.[activeTab] ||
              form.watch("thresholds")[activeTab] ===
                originalThresholds[activeTab]
            }
            permissionMessage="You don't have permission to change the voting threshold"
          />
        </PageCard>

        <PageCard>
          <div>
            <h3 className="text-lg font-semibold">Vote Duration</h3>
            <p className="text-sm text-muted-foreground">
              The length of time (in days) a proposal will remain open for
              voting. If voting is not completed within this period, the
              decision expires.
              {hasApproversAndGovernance
                ? " This duration applies equally to both Governance and Approver roles."
                : " This duration is consistent across all treasury roles."}
            </p>
          </div>

          <FormField
            control={form.control}
            name="voteDuration"
            render={({ field }) => (
              <FormItem>
                <Label htmlFor="vote-duration">Days</Label>
                <FormControl>
                  <Input
                    id="vote-duration"
                    type="number"
                    min="1"
                    max="999"
                    step="1"
                    disabled={!isAuthorized || hasPendingVotingRequest}
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
            isAuthorized={isAuthorized}
            accountId={accountId}
            disabled={
              !form.formState.dirtyFields.voteDuration ||
              !!form.formState.errors.voteDuration
            }
            permissionMessage="You don't have permission to change the vote duration"
          />
        </PageCard>
      </div>
    </Form>
  );
}
