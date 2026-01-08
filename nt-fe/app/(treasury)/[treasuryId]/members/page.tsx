"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { Button } from "@/components/button";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { useState, useMemo, useCallback } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  isValidNearAddressFormat,
  validateNearAddress,
} from "@/lib/near-validation";
import { hasPermission } from "@/lib/config-utils";
import { useProposals } from "@/hooks/use-proposals";
import { useQueryClient } from "@tanstack/react-query";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { toast } from "sonner";
import { encodeToMarkdown } from "@/lib/utils";
import { useFormatDate } from "@/components/formatted-date";
import { MemberModal } from "./components/modals/member-modal";
import { PreviewModal } from "./components/modals/preview-modal";
import { DeleteConfirmationModal } from "./components/modals/delete-confirmation-modal";
import { User } from "@/components/user";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Pencil,
  Trash2,
  UsersRound,
  UserRoundPlus,
  UserRoundPen,
} from "lucide-react";
import { PageCard } from "@/components/card";
import {
  Tabs,
  TabsContent,
  TabsContents,
  TabsList,
  TabsTrigger,
} from "@/components/underline-tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useMemberValidation } from "./hooks/use-member-validation";

interface Member {
  accountId: string;
  roles: string[];
}

interface PendingMember extends Member {
  proposalId: number;
  proposer: string;
  createdAt: string;
  addedRoles?: string[];
  removedRoles?: string[];
}

interface AddMemberFormData {
  members: Array<{
    accountId: string;
    selectedRoles: string[];
  }>;
}

export default function MembersPage() {
  const { selectedTreasury } = useTreasury();
  const { data: policy, isLoading } = useTreasuryPolicy(selectedTreasury);
  const { accountId } = useNear();
  const queryClient = useQueryClient();
  const formatDate = useFormatDate();
  const [activeTab, setActiveTab] = useState<"active" | "pending">("active");
  const [isAddMemberModalOpen, setIsAddMemberModalOpen] = useState(false);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [isEditRolesModalOpen, setIsEditRolesModalOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [isValidatingAddresses, setIsValidatingAddresses] = useState(false);
  const [isCreatingProposal, setIsCreatingProposal] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [memberToDelete, setMemberToDelete] = useState<Member | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  // Fetch pending proposals to check for active member requests
  const { data: pendingProposals } = useProposals(selectedTreasury, {
    statuses: ["InProgress"],
    proposal_types: ["Change Policy"],
    search: "members",
    sort_direction: "desc",
    sort_by: "CreationTime",
  });

  // Check if there are pending member-related proposals
  const hasPendingMemberRequest = useMemo(() => {
    if (!pendingProposals?.proposals) return false;
    return pendingProposals.proposals.length > 0;
  }, [pendingProposals]);

  // Check if user has permission to add members
  const canAddMember = useMemo(() => {
    if (!policy || !accountId) return false;
    return hasPermission(policy, accountId, "policy", "AddProposal");
  }, [policy, accountId]);

  // Extract unique members from policy roles first (needed for schema validation)
  const existingMembers = useMemo(() => {
    if (!policy?.roles) return [];

    const memberMap = new Map<string, Set<string>>();

    // Iterate through each role and extract members
    for (const role of policy.roles) {
      if (typeof role.kind === "object" && "Group" in role.kind) {
        const accountIds = role.kind.Group;
        const roleName = role.name;

        for (const accountId of accountIds) {
          let roles = memberMap.get(accountId);
          if (!roles) {
            roles = new Set();
            memberMap.set(accountId, roles);
          }
          roles.add(roleName);
        }
      }
    }

    // Convert to array of Member objects and sort alphabetically
    return Array.from(memberMap, ([accountId, rolesSet]) => ({
      accountId,
      roles: Array.from(rolesSet),
    })).sort((a, b) => a.accountId.toLowerCase().localeCompare(b.accountId.toLowerCase()));
  }, [policy]);

  // Track current modal mode for schema validation
  const [currentModalMode, setCurrentModalMode] = useState<"add" | "edit">("add");
  const [membersBeingEdited, setMembersBeingEdited] = useState<string[]>([]);

  // Create dynamic schema with access to existing members and mode
  const addMemberSchemaWithContext = useMemo(() => {
    const existingMembersSet = new Set(
      existingMembers.map((m) => m.accountId.toLowerCase())
    )
    return z.object({
      members: z
        .array(
          z.object({
            accountId: z
              .string()
              .min(1, "Account ID is required")
              .refine(isValidNearAddressFormat, {
                message: "Invalid NEAR address.",
              }),
            selectedRoles: z
              .array(z.string())
              .min(1, "At least one role must be selected"),
          })
        )
        .min(1, "At least one member is required")
        .superRefine((members, ctx) => {
          const seenAccountIds = new Map<string, number>();

          members.forEach((member, index) => {
            if (!member.accountId) return;

            const normalizedId = member.accountId.toLowerCase();

            // Check for duplicates within the form
            const firstOccurrence = seenAccountIds.get(normalizedId);
            if (firstOccurrence !== undefined) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: "This member has already been added above",
                path: [index, "accountId"],
              });
            } else {
              seenAccountIds.set(normalizedId, index);

              // Check if member already exists in treasury (only for add mode)
              // In edit mode, skip this check if the member is being edited
              if (
                currentModalMode === "add" &&
                existingMembersSet.has(normalizedId)
              ) {
                ctx.addIssue({
                  code: z.ZodIssueCode.custom,
                  message: "This member already exists in the treasury",
                  path: [index, "accountId"],
                });
              }
            }
          });
        }),
    });
  }, [existingMembers, currentModalMode, membersBeingEdited]);

  const form = useForm<AddMemberFormData>({
    resolver: zodResolver(addMemberSchemaWithContext),
    mode: "onChange",
    defaultValues: {
      members: [{ accountId: "", selectedRoles: [] }],
    },
  });

  // Available roles from policy (excluding "all" role)
  const availableRoles = useMemo(() => {
    if (!policy?.roles) return [];
    return policy.roles.filter(
      (role) =>
        typeof role.kind === "object" &&
        "Group" in role.kind &&
        role.name.toLowerCase() !== "all"
    );
  }, [policy]);

  const activeMembers = existingMembers;

  // Use member validation hook
  const {
    canModifyMember,
    canEditBulk,
    canDeleteBulk,
    canConfirmEdit,
    canAddNewMember,
  } = useMemberValidation(existingMembers, {
    accountId: accountId || undefined,
    canAddMember,
    hasPendingMemberRequest,
  });

  // Extract pending members from proposal descriptions
  const pendingProposalsData = useMemo(() => {
    if (!pendingProposals?.proposals) return [];

    return pendingProposals.proposals.map((proposal) => {
      const memberChanges = new Map<
        string,
        { addedRoles: Set<string>; removedRoles: Set<string> }
      >();

      if (proposal.description) {
        // Parse "add" operations: add "accountId" to ["Role1", "Role2"]
        const addPattern = /add "([^"]+)" to \[([^\]]+)\]/gi;
        let match;

        while ((match = addPattern.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const rolesStr = match[2];
          const roles =
            rolesStr.match(/"([^"]+)"/g)?.map((r) => r.replace(/"/g, "")) || [];

          if (accountId) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, {
                addedRoles: new Set(),
                removedRoles: new Set(),
              });
            }
            roles.forEach((role) =>
              memberChanges.get(accountId)?.addedRoles.add(role)
            );
          }
        }

        // Parse "remove" operations: remove "accountId" from ["Role1", "Role2"]
        const removePattern = /remove "([^"]+)" from \[([^\]]+)\]/gi;

        while ((match = removePattern.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const rolesStr = match[2];
          const roles =
            rolesStr.match(/"([^"]+)"/g)?.map((r) => r.replace(/"/g, "")) || [];

          if (accountId) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, {
                addedRoles: new Set(),
                removedRoles: new Set(),
              });
            }
            roles.forEach((role) =>
              memberChanges.get(accountId)?.removedRoles.add(role)
            );
          }
        }

        // Parse "edit" operations: edit "accountId": removed from ["Role1"], added to ["Role2"]
        const editPattern =
          /edit "([^"]+)":\s*(?:removed from \[([^\]]+)\])?\s*,?\s*(?:added to \[([^\]]+)\])?/gi;

        while ((match = editPattern.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const removedRolesStr = match[2];
          const addedRolesStr = match[3];

          if (accountId) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, {
                addedRoles: new Set(),
                removedRoles: new Set(),
              });
            }

            // Parse removed roles
            if (removedRolesStr) {
              const removedRoles =
                removedRolesStr
                  .match(/"([^"]+)"/g)
                  ?.map((r) => r.replace(/"/g, "")) || [];
              removedRoles.forEach((role) =>
                memberChanges.get(accountId)?.removedRoles.add(role)
              );
            }

            // Parse added roles
            if (addedRolesStr) {
              const addedRoles =
                addedRolesStr
                  .match(/"([^"]+)"/g)
                  ?.map((r) => r.replace(/"/g, "")) || [];
              addedRoles.forEach((role) =>
                memberChanges.get(accountId)?.addedRoles.add(role)
              );
            }
          }
        }
      }

      // Convert member changes to array
      const members: PendingMember[] = [];
      for (const [accountId, changes] of memberChanges.entries()) {
        const addedRoles = Array.from(changes.addedRoles);
        const removedRoles = Array.from(changes.removedRoles);

        // Only add if there are actual changes
        if (addedRoles.length > 0 || removedRoles.length > 0) {
          members.push({
            accountId,
            roles: addedRoles,
            proposalId: proposal.id,
            proposer: proposal.proposer,
            createdAt: proposal.submission_time,
            addedRoles,
            removedRoles,
          });
        }
      }

      return {
        proposalId: proposal.id,
        proposer: proposal.proposer,
        createdAt: proposal.submission_time,
        members,
      };
    });
  }, [pendingProposals]);

  const handleReviewRequest = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;

    // Validate all addresses exist on blockchain (in parallel)
    setIsValidatingAddresses(true);
    const members = form.getValues("members");

    try {
      // Validate all addresses in parallel
      const validationResults = await Promise.all(
        members.map((member, index) =>
          validateNearAddress(member.accountId).then((error) => ({
            index,
            error,
          }))
        )
      );

      // Check if any validation failed
      const failedValidation = validationResults.find((result) => result.error);
      if (failedValidation) {
        form.setError(`members.${failedValidation.index}.accountId`, {
          type: "manual",
          message: failedValidation.error || "Invalid address",
        });
        setIsValidatingAddresses(false);
        return;
      }

      // All addresses are valid, proceed to preview
      setIsValidatingAddresses(false);
      setIsAddMemberModalOpen(false);
      setIsPreviewModalOpen(true);
    } catch (error) {
      console.error("Error validating addresses:", error);
      setIsValidatingAddresses(false);
    }
  };

  const handleAddMembersSubmit = async () => {
    if (!policy || !selectedTreasury) return;

    const data = form.getValues();

    try {
      // Transform form data to the format expected by applyMemberRolesToPolicy
      const membersList = data.members.map(
        ({
          accountId,
          selectedRoles,
        }: {
          accountId: string;
          selectedRoles: string[];
        }) => ({
          member: accountId,
          roles: selectedRoles,
        })
      );

      const { updatedPolicy, summary } = applyMemberRolesToPolicy(
        membersList,
        false
      );

      await createPolicyChangeProposal(
        updatedPolicy,
        summary,
        "Update Policy - Add New Members",
        "New member request created successfully"
      );

      setIsPreviewModalOpen(false);
      form.reset({
        members: [{ accountId: "", selectedRoles: [] }],
      });
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
    }
  };

  // Apply member role changes to policy (handles both add and edit for multiple members)
  const applyMemberRolesToPolicy = (
    membersList: Array<{ member: string; roles: string[] }>,
    isEdit: boolean = false
  ) => {
    if (!policy || !Array.isArray(policy.roles)) {
      return { updatedPolicy: policy, summary: "" };
    }

    const summaryLines = membersList.map(({ member, roles }) => {
      if (isEdit) {
        // For edit, calculate what's being added and removed
        const currentMember = existingMembers.find(
          (m) => m.accountId === member
        );
        if (currentMember) {
          const currentRoles = new Set(currentMember.roles);
          const newRolesSet = new Set(roles);

          const addedRoles = roles.filter((r) => !currentRoles.has(r));
          const removedRoles = currentMember.roles.filter(
            (r) => !newRolesSet.has(r)
          );

          // Build descriptive summary showing both changes
          const parts: string[] = [];
          if (removedRoles.length > 0) {
            parts.push(
              `removed from [${removedRoles.map((r) => `"${r}"`).join(", ")}]`
            );
          }
          if (addedRoles.length > 0) {
            parts.push(
              `added to [${addedRoles.map((r) => `"${r}"`).join(", ")}]`
            );
          }

          return `- edit "${member}": ${parts.join(", ")}`;
        }
        return `- edit "${member}" to [${roles
          .map((r) => `"${r}"`)
          .join(", ")}]`;
      }
      return `- add "${member}" to [${roles.map((r) => `"${r}"`).join(", ")}]`;
    });

    const updatedPolicy = structuredClone(policy);

    // Update roles efficiently - single pass through roles
    updatedPolicy.roles = updatedPolicy.roles.map((role: any) => {
      const roleName = role.name;
      let newGroup = [...(role.kind.Group || [])];

      // Process each member for this role
      membersList.forEach(({ member, roles }) => {
        const shouldHaveRole = roles.includes(roleName);
        const isInRole = newGroup.includes(member);

        if (shouldHaveRole && !isInRole) {
          // Add member to this role
          newGroup.push(member);
        } else if (!shouldHaveRole && isInRole) {
          // Remove member from this role
          newGroup = newGroup.filter((m) => m !== member);
        }
      });

      role.kind.Group = newGroup;
      return role;
    });

    const summary = summaryLines.join("\n");
    return { updatedPolicy, summary };
  };

  // Helper function to remove members from policy
  const removeMembersFromPolicy = (
    membersToRemove: Array<{ member: string; roles: string[] }>
  ) => {
    if (!policy || !Array.isArray(policy.roles)) {
      return { updatedPolicy: policy, summary: "" };
    }

    const summaryLines = membersToRemove.map(({ member, roles }) => {
      return `- remove "${member}" from [${roles
        .map((r) => `"${r}"`)
        .join(", ")}]`;
    });

    const memberIdsToRemove = membersToRemove.map((m) => m.member);

    const updatedPolicy = structuredClone(policy);

    // Update roles by filtering out members to remove
    updatedPolicy.roles.forEach((role: any) => {
      role.kind.Group = (role.kind.Group || []).filter(
        (m: string) => !memberIdsToRemove.includes(m)
      );
    });

    const summary = summaryLines.join("\n");
    return { updatedPolicy, summary };
  };

  const { createProposal } = useNear();

  // Generic function to create policy change proposal
  const createPolicyChangeProposal = async (
    updatedPolicy: any,
    summary: string,
    title: string,
    successMessage: string
  ) => {
    if (!policy || !selectedTreasury) return;

    try {
      const description = {
        title,
        summary,
      };

      const proposalBond = policy?.proposal_bond || "0";

      await createProposal(successMessage, {
        treasuryId: selectedTreasury,
        proposalBond,
        proposal: {
          description: encodeToMarkdown(description),
          kind: {
            ChangePolicy: {
              policy: updatedPolicy,
            },
          },
        },
      });

      // Refetch proposals to show the newly created proposal
      queryClient.invalidateQueries({ queryKey: ["proposals", selectedTreasury] });
    } catch (error) {
      console.error("Failed to create proposal:", error);
      toast.error("Failed to create proposal");
      throw error;
    }
  };

  // Handle member edit (single or multiple)
  const handleEditMembersSubmit = async (
    membersData: Array<{ accountId: string; selectedRoles: string[] }>
  ) => {
    if (!policy || !selectedTreasury) return;

    try {
      setIsCreatingProposal(true);
      // Transform to the format expected by applyMemberRolesToPolicy
      const membersList = membersData.map((m) => ({
        member: m.accountId,
        roles: m.selectedRoles,
      }));

      const { updatedPolicy, summary } = applyMemberRolesToPolicy(
        membersList,
        true
      );

      const title =
        membersData.length === 1
          ? "Update Policy - Edit Member Permissions"
          : "Update Policy - Edit Multiple Members";
      const successMessage =
        membersData.length === 1
          ? "Member roles update request created successfully"
          : "Bulk member roles update request created successfully";

      await createPolicyChangeProposal(
        updatedPolicy,
        summary,
        title,
        successMessage
      );

      setIsEditRolesModalOpen(false);
      setSelectedMember(null);
      setSelectedMembers([]);
      setCurrentModalMode("add");
      setMembersBeingEdited([]);
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
      throw error;
    } finally {
      setIsCreatingProposal(false);
    }
  };

  // Handle delete members submission
  const handleDeleteMembersSubmit = async () => {
    if (!policy || !selectedTreasury) return;

    try {
      const membersToRemove =
        selectedMembers.length > 0
          ? selectedMembers.map((accountId) => {
              const member = activeMembers.find(
                (m) => m.accountId === accountId
              );
              return { member: accountId, roles: member?.roles || [] };
            })
          : memberToDelete
          ? [{ member: memberToDelete.accountId, roles: memberToDelete.roles }]
          : [];

      if (membersToRemove.length === 0) return;

      const { updatedPolicy, summary } =
        removeMembersFromPolicy(membersToRemove);

      await createPolicyChangeProposal(
        updatedPolicy,
        summary,
        "Update Policy - Remove Member" +
          (membersToRemove.length > 1 ? "s" : ""),
        `Member removal request created successfully`
      );

      setIsDeleteModalOpen(false);
      setMemberToDelete(null);
      setSelectedMembers([]);
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
    }
  };

  const handleOpenAddMemberModal = useCallback(() => {
    setCurrentModalMode("add");
    setMembersBeingEdited([]);
    form.reset({
      members: [{ accountId: "", selectedRoles: [] }],
    });
    setIsAddMemberModalOpen(true);
  }, [form]);

  const handleEditMember = useCallback(
    (member: Member) => {
      setSelectedMember(member);
      setCurrentModalMode("edit");
      setMembersBeingEdited([member.accountId]);
      // Reset form with the selected member's data
      form.reset({
        members: [{ accountId: member.accountId, selectedRoles: member.roles }],
      });
      setIsEditRolesModalOpen(true);
    },
    [form]
  );

  // Handle bulk edit
  const handleBulkEdit = useCallback(() => {
    const membersToEdit = activeMembers.filter((m) =>
      selectedMembers.includes(m.accountId)
    );
    setCurrentModalMode("edit");
    setMembersBeingEdited(membersToEdit.map((m) => m.accountId));
    form.reset({
      members: membersToEdit.map((m) => ({
        accountId: m.accountId,
        selectedRoles: m.roles,
      })),
    });
    setIsEditRolesModalOpen(true);
  }, [activeMembers, selectedMembers, form]);

  // Handle bulk delete
  const handleBulkDelete = useCallback(() => {
    setIsDeleteModalOpen(true);
  }, []);

  // Handle checkbox toggle
  const handleToggleMember = useCallback((accountId: string) => {
    setSelectedMembers((prev) =>
      prev.includes(accountId)
        ? prev.filter((id) => id !== accountId)
        : [...prev, accountId]
    );
  }, []);

  // Handle select all
  const handleToggleAll = useCallback(() => {
    if (selectedMembers.length === activeMembers.length) {
      setSelectedMembers([]);
    } else {
      setSelectedMembers(activeMembers.map((m) => m.accountId));
    }
  }, [selectedMembers.length, activeMembers]);

  // Clear selection when changing tabs
  const handleTabChange = useCallback((value: string) => {
    setActiveTab(value as "active" | "pending");
    setSelectedMembers([]);
  }, []);

  // Render pending members table (similar to requests page)
  const renderPendingMembersTable = useCallback(() => {
    if (isLoading) {
      return (
        <div className="flex items-center justify-center py-8">
          <p className="text-muted-foreground">Loading...</p>
        </div>
      );
    }

    if (pendingProposalsData.length === 0) {
      return (
        <div className="flex flex-col items-center justify-center py-12 gap-3">
          <div className="relative w-20 h-14">
            <div className="absolute left-0 top-0 w-12 h-12 rounded-full border-4 border-background bg-muted flex items-center justify-center">
              <UserRoundPlus className="w-6 h-6 text-muted-foreground" />
            </div>
            <div className="absolute right-0 top-5 w-12 h-12 rounded-full border-4 border-background bg-muted flex items-center justify-center">
              <UserRoundPen className="w-6 h-6 text-muted-foreground" />
            </div>
          </div>
          <p className="text-foreground font-medium mt-2">
            No pending requests.
          </p>
        </div>
      );
    }

    return (
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Request
              </span>
            </TableHead>
            <TableHead>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Transaction
              </span>
            </TableHead>
            <TableHead>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Requester
              </span>
            </TableHead>
            <TableHead className="text-right">
              <span className="text-xs font-medium uppercase text-muted-foreground"></span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pendingProposalsData.map((proposalData) => {
            const { proposalId, proposer, createdAt, members } = proposalData;

            // Determine action text based on the proposal intent
            let actionText = "Update Member";
            if (members.length > 0) {
              // Check if it's purely adding (only addedRoles, no removedRoles)
              const isAdd = members.every(
                (m) =>
                  (m.addedRoles?.length || 0) > 0 &&
                  (m.removedRoles?.length || 0) === 0
              );
              // Check if it's purely removing (only removedRoles, no addedRoles)
              const isRemove = members.every(
                (m) =>
                  (m.removedRoles?.length || 0) > 0 &&
                  (m.addedRoles?.length || 0) === 0
              );

              if (isAdd) {
                actionText = "Add New Member";
              } else if (isRemove) {
                actionText = "Remove Member";
              }
            }

            // Only show member count if we successfully parsed members
            const memberText =
              members.length > 0
                ? members.length === 1
                  ? `Member: ${members[0].accountId}`
                  : `${members.length} Members`
                : null;

            // Format date from nanoseconds timestamp
            const formattedDate = formatDate(
              new Date(parseInt(createdAt) / 1000000)
            );

            return (
              <TableRow key={proposalId}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center justify-center w-8 h-8 shrink-0 bg-muted rounded-sm p-2">
                      <UsersRound className="w-6 h-6" />
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{actionText}</span>
                      <span className="text-xs text-muted-foreground">
                        {formattedDate}
                      </span>
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{actionText}</span>
                    {memberText && (
                      <span className="text-xs text-muted-foreground">
                        {memberText}
                      </span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  <User accountId={proposer} size="sm" withLink={false} />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    variant="outline"
                    onClick={() => {
                      if (typeof window !== "undefined") {
                        window.location.href = `/${selectedTreasury}/requests/${proposalId}`;
                      }
                    }}
                  >
                    View Request
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }, [isLoading, pendingProposalsData, selectedTreasury, formatDate]);

  // Render members table
  const renderMembersTable = (members: Member[]) => {
    if (isLoading) {
      return (
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-12"></TableHead>
              <TableHead>
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  Member
                </span>
              </TableHead>
              <TableHead>
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  Permissions
                </span>
              </TableHead>
              <TableHead className="w-24"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...Array(5)].map((_, i) => (
              <TableRow key={i}>
                <TableCell>
                  <div className="w-4 h-4 bg-muted rounded animate-pulse" />
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-muted animate-pulse" />
                    <div className="space-y-2 flex-1">
                      <div className="h-4 bg-muted rounded w-48 animate-pulse" />
                      <div className="h-3 bg-muted rounded w-32 animate-pulse" />
                    </div>
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex gap-2">
                    <div className="h-7 bg-muted rounded w-20 animate-pulse" />
                    <div className="h-7 bg-muted rounded w-24 animate-pulse" />
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <div className="w-8 h-8 bg-muted rounded animate-pulse" />
                    <div className="w-8 h-8 bg-muted rounded animate-pulse" />
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      );
    }

    if (members.length === 0) {
      return (
        <div className="flex items-center justify-center py-8">
          <p className="text-muted-foreground">No active members found.</p>
        </div>
      );
    }

    return (
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12">
              <Checkbox
                checked={
                  selectedMembers.length === activeMembers.length &&
                  activeMembers.length > 0
                    ? true
                    : selectedMembers.length > 0
                    ? "indeterminate"
                    : false
                }
                onCheckedChange={handleToggleAll}
              />
            </TableHead>
            <TableHead>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Member
              </span>
            </TableHead>
            <TableHead>
              <span className="text-xs font-medium uppercase text-muted-foreground">
                Permissions
              </span>
            </TableHead>
            <TableHead className="w-24"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const validation = canModifyMember(member);

            return (
              <TableRow key={member.accountId} className="group">
                <TableCell>
                  <Checkbox
                    checked={selectedMembers.includes(member.accountId)}
                    onCheckedChange={() => handleToggleMember(member.accountId)}
                    disabled={!validation.canModify}
                  />
                </TableCell>
                <TableCell>
                  <User
                    accountId={member.accountId}
                    size="md"
                    withLink={false}
                  />
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {member.roles.map((role) => (
                      <span
                        key={role}
                        className="px-3 py-1 rounded-md bg-muted text-foreground text-sm font-medium"
                      >
                        {role}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => handleEditMember(member)}
                          disabled={!validation.canModify}
                          className={`p-2 rounded transition-colors ${
                            !validation.canModify
                              ? "text-muted-foreground/40 cursor-not-allowed"
                              : "text-foreground hover:bg-muted"
                          }`}
                        >
                          <Pencil className="w-4 h-4" />
                        </button>
                      </TooltipTrigger>
                      {!validation.canModify && (
                        <TooltipContent className="max-w-[280px]">
                          <p>{validation.reason}</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={() => {
                            setMemberToDelete(member);
                            setIsDeleteModalOpen(true);
                          }}
                          disabled={!validation.canModify}
                          className={`p-2 rounded transition-colors ${
                            !validation.canModify
                              ? "text-destructive/40 cursor-not-allowed"
                              : "text-destructive hover:bg-destructive/10"
                          }`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </TooltipTrigger>
                      {!validation.canModify && (
                        <TooltipContent className="max-w-[280px]">
                          <p>{validation.reason}</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  };

  return (
    <PageComponentLayout
      title="Members"
      description="Manage team members and permissions"
    >
      <PageCard>
        <Tabs
          value={activeTab}
          onValueChange={(value) =>
            handleTabChange(value as "active" | "pending")
          }
        >
          <div className="flex items-center justify-between">
            <TabsList className="w-fit border-none">
              <TabsTrigger value="active">
                Active Members
                <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-1">
                  {activeMembers.length}
                </span>
              </TabsTrigger>
              <TabsTrigger value="pending">
                Pending
                <span className="text-xs text-muted-foreground bg-muted rounded-full px-2 py-1">
                  {pendingProposalsData.length}
                </span>
              </TabsTrigger>
            </TabsList>

            {isLoading ? (
              <div className="h-10 w-44 bg-muted rounded-lg animate-pulse" />
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0}>
                    <Button
                      type="button"
                      onClick={handleOpenAddMemberModal}
                      className="flex items-center gap-2 text-md"
                      disabled={!canAddNewMember().canModify}
                    >
                      <span className="text-lg">+</span>
                      Add New Member
                    </Button>
                  </span>
                </TooltipTrigger>
                {!canAddNewMember().canModify && (
                  <TooltipContent className="max-w-[280px]">
                    <p>{canAddNewMember().reason}</p>
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </div>

          {/* Bulk Actions Bar */}
          {selectedMembers.length > 0 && activeTab === "active" && (
            <div className="flex items-center justify-between pt-2 pb-2 px-2 border-b">
              <span className="font-semibold">
                {selectedMembers.length} member
                {selectedMembers.length !== 1 ? "s" : ""} selected
              </span>
              <div className="flex items-center gap-2">
                {(() => {
                  const membersToModify = activeMembers.filter((m) =>
                    selectedMembers.includes(m.accountId)
                  );
                  const deleteValidation = canDeleteBulk(membersToModify);
                  const editValidation = canEditBulk();

                  return (
                    <>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleBulkDelete}
                              disabled={!deleteValidation.canModify}
                              className="h-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                            >
                              <Trash2 className="w-4 h-4 mr-1" />
                              Remove
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {!deleteValidation.canModify && (
                          <TooltipContent className="max-w-[280px]">
                            <p>{deleteValidation.reason}</p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={handleBulkEdit}
                              disabled={!editValidation.canModify}
                              className="h-9"
                            >
                              <Pencil className="w-4 h-4 mr-1" />
                              Edit
                            </Button>
                          </span>
                        </TooltipTrigger>
                        {!editValidation.canModify && (
                          <TooltipContent className="max-w-[280px]">
                            <p>{editValidation.reason}</p>
                          </TooltipContent>
                        )}
                      </Tooltip>
                    </>
                  );
                })()}
              </div>
            </div>
          )}

          <TabsContents>
            <TabsContent value="active">
              {renderMembersTable(activeMembers)}
            </TabsContent>
            <TabsContent value="pending">
              {renderPendingMembersTable()}
            </TabsContent>
          </TabsContents>
        </Tabs>
      </PageCard>

      {/* Add New Member Modal */}
      <MemberModal
        isOpen={isAddMemberModalOpen}
        onClose={() => {
          setIsAddMemberModalOpen(false);
          setCurrentModalMode("add");
          setMembersBeingEdited([]);
        }}
        form={form}
        availableRoles={availableRoles}
        onReviewRequest={handleReviewRequest}
        isValidatingAddresses={isValidatingAddresses}
        mode="add"
      />

      {/* Preview Modal */}
      <PreviewModal
        isOpen={isPreviewModalOpen}
        onClose={() => setIsPreviewModalOpen(false)}
        onBack={() => {
          setIsPreviewModalOpen(false);
          setIsAddMemberModalOpen(true);
        }}
        form={form}
        onSubmit={handleAddMembersSubmit}
      />

      {/* Edit Roles Modal */}
      <MemberModal
        isOpen={isEditRolesModalOpen}
        onClose={() => {
          setIsEditRolesModalOpen(false);
          setSelectedMember(null);
          setCurrentModalMode("add");
          setMembersBeingEdited([]);
        }}
        form={form}
        availableRoles={availableRoles}
        onReviewRequest={async () => {
          const membersData = form.getValues("members");
          await handleEditMembersSubmit(membersData);
        }}
        isValidatingAddresses={isCreatingProposal}
        mode="edit"
        existingMember={selectedMember}
        validationError={(() => {
          const membersData = form.watch("members");

          // Build edits array for validation
          const edits = membersData.map(
            (m: { accountId: string; selectedRoles: string[] }) => {
              const existingMember = activeMembers.find(
                (am) => am.accountId === m.accountId
              );
              return {
                accountId: m.accountId,
                oldRoles: existingMember?.roles || [],
                newRoles: m.selectedRoles,
              };
            }
          );

          // Validate the edits
          const validation = canConfirmEdit(edits);
          return validation.canModify ? undefined : validation.reason;
        })()}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setMemberToDelete(null);
          setSelectedMembers([]);
        }}
        member={memberToDelete}
        members={
          selectedMembers.length > 0
            ? activeMembers.filter((m) => selectedMembers.includes(m.accountId))
            : undefined
        }
        onConfirm={handleDeleteMembersSubmit}
        validationError={(() => {
          const membersToDelete =
            selectedMembers.length > 0
              ? activeMembers.filter((m) =>
                  selectedMembers.includes(m.accountId)
                )
              : memberToDelete
              ? [memberToDelete]
              : [];

          if (membersToDelete.length === 0) return undefined;

          const validation = canDeleteBulk(membersToDelete);
          return validation.canModify ? undefined : validation.reason;
        })()}
      />
    </PageComponentLayout>
  );
}
