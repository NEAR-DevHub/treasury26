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
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { encodeToMarkdown } from "@/lib/utils";
import { MemberModal } from "./components/modals/member-modal";
import { PreviewModal } from "./components/modals/preview-modal";
import { DeleteConfirmationModal } from "./components/modals/delete-confirmation-modal";
import { User } from "@/components/user";
import { Checkbox } from "@/components/ui/checkbox";
import { Pencil, Trash2, Info } from "lucide-react";
import { PageCard } from "@/components/card";
import { RoleBadge } from "@/components/role-badge";
import { Tooltip } from "@/components/tooltip";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/table";
import { useMemberValidation } from "./hooks/use-member-validation";
import { useTreasuryMembers } from "@/hooks/use-treasury-members";
import { AuthButton } from "@/components/auth-button";
import { RolePermission } from "@/types/policy";
import { sortRolesByOrder, getRoleDescription } from "@/lib/role-utils";
import { formatRoleName } from "@/components/role-name";

interface Member {
  accountId: string;
  roles: string[];
}

interface AddMemberFormData {
  members: Array<{
    accountId: string;
    roles: string[];
  }>;
}

function PermissionsHeader({ policyRoles }: { policyRoles: RolePermission[] }) {
  // Get role descriptions and sort them
  const roleNames = policyRoles.map(r => r.name);
  const sortedRoleNames = sortRolesByOrder(roleNames);
  
  const sortedDescriptions = sortedRoleNames
    .map(name => ({
      name,
      description: getRoleDescription(name) || ""
    }))
    .filter(r => r.description); // Only include roles with descriptions

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs font-medium uppercase text-muted-foreground">
        Permissions
      </span>
      {sortedDescriptions.length > 0 && (
        <Tooltip
          content={
            <div className="space-y-3">
              {sortedDescriptions.map((role) => (
                <div key={role.name}>
                  <p className="font-semibold mb-1">{formatRoleName(role.name)}</p>
                  <p className="text-xs">{role.description}</p>
                </div>
              ))}
            </div>
          }
          contentProps={{ className: "max-w-[320px]" }}
        >
          <Info className="w-3.5 h-3.5 text-muted-foreground cursor-help" />
        </Tooltip>
      )}
    </div>
  );
}

export default function MembersPage() {
  const { selectedTreasury } = useTreasury();
  const { data: policy, isLoading } = useTreasuryPolicy(selectedTreasury);
  const { accountId } = useNear();
  const queryClient = useQueryClient();
  const router = useRouter();
  const [isAddMemberModalOpen, setIsAddMemberModalOpen] = useState(false);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [isEditRolesModalOpen, setIsEditRolesModalOpen] = useState(false);
  const [isEditPreviewModalOpen, setIsEditPreviewModalOpen] = useState(false);
  const [isValidatingAddresses, setIsValidatingAddresses] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [memberToDelete, setMemberToDelete] = useState<Member | null>(null);
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);

  // Fetch pending proposals to check for active member requests
  const { data: pendingProposals } = useProposals(selectedTreasury, {
    statuses: ["InProgress"],
    proposal_types: ["ChangePolicy", "ChangePolicyUpdateParameters"],
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
  const { members: existingMembers } = useTreasuryMembers(selectedTreasury);

  // Track current modal mode for schema validation
  const [currentModalMode, setCurrentModalMode] = useState<"add" | "edit">(
    "add"
  );
  const [membersBeingEdited, setMembersBeingEdited] = useState<string[]>([]);
  const [originalMembersData, setOriginalMembersData] = useState<
    Array<{ accountId: string; roles: string[] }>
  >([]);

  // Create dynamic schema with access to existing members and mode
  const addMemberSchemaWithContext = useMemo(() => {
    const existingMembersSet = new Set(
      existingMembers.map((m) => m.accountId.toLowerCase())
    );
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
            roles: z
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
      members: [{ accountId: "", roles: [] }],
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
    canDeleteBulk,
    canConfirmEdit,
  } = useMemberValidation(existingMembers, {
    accountId: accountId || undefined,
    canAddMember,
    hasPendingMemberRequest,
  });

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
        ({ accountId, roles }: { accountId: string; roles: string[] }) => ({
          member: accountId,
          roles: roles,
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
        members: [{ accountId: "", roles: [] }],
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

          // Only include if there are actual changes
          if (parts.length > 0) {
            return `- edit "${member}": ${parts.join(", ")}`;
          }
          return null; // No changes, skip this member
        }
        return `- edit "${member}" to [${roles
          .map((r) => `"${r}"`)
          .join(", ")}]`;
      }
      return `- add "${member}" to [${roles.map((r) => `"${r}"`).join(", ")}]`;
    }).filter(Boolean); // Filter out null entries

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
      queryClient.invalidateQueries({
        queryKey: ["proposals", selectedTreasury],
      });
    } catch (error) {
      console.error("Failed to create proposal:", error);
      toast.error("Failed to create proposal");
      throw error;
    }
  };

  // Handle member edit (single or multiple)
  const handleEditMembersSubmit = async (
    membersData: Array<{ accountId: string; roles: string[] }>
  ) => {
    if (!policy || !selectedTreasury) return;

    try {
      const membersList = membersData.map((m) => ({
        member: m.accountId,
        roles: m.roles,
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

      setIsEditPreviewModalOpen(false);
      setIsEditRolesModalOpen(false);
      setSelectedMembers([]);
      setCurrentModalMode("add");
      setMembersBeingEdited([]);
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
      throw error;
    }
  };

  // Handle edit review request
  const handleEditReviewRequest = () => {
    // Validate the form
    if (!form.formState.isValid) return;

    // Close edit modal and open preview modal
    setIsEditRolesModalOpen(false);
    setIsEditPreviewModalOpen(true);
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
      members: [{ accountId: "", roles: [] }],
    });
    setIsAddMemberModalOpen(true);
  }, [form]);

  const handleEditMember = useCallback(
    (member: Member) => {
      setCurrentModalMode("edit");
      setMembersBeingEdited([member.accountId]);
      // Store original member data for comparison
      setOriginalMembersData([
        { accountId: member.accountId, roles: member.roles },
      ]);
      // Reset form with the selected member's data
      form.reset({
        members: [{ accountId: member.accountId, roles: member.roles }],
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
    // Store original member data for comparison
    setOriginalMembersData(
      membersToEdit.map((m) => ({
        accountId: m.accountId,
        roles: m.roles,
      }))
    );
    form.reset({
      members: membersToEdit.map((m) => ({
        accountId: m.accountId,
        roles: m.roles,
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

  // Validate bulk delete
  const bulkDeleteValidation = useMemo(() => {
    if (selectedMembers.length === 0) return { canModify: true };
    
    const membersToDelete = activeMembers.filter((m) =>
      selectedMembers.includes(m.accountId)
    );
    
    return canDeleteBulk(membersToDelete);
  }, [selectedMembers, activeMembers, canDeleteBulk]);

  // Render members table
  const renderMembersTable = (members: Member[]) => {
    if (isLoading) {
      return (
        <Table>
          <TableHeader className="bg-general-tertiary">
            <TableRow className="hover:bg-transparent">
              <TableHead className="w-12"></TableHead>
              <TableHead>
                <span className="text-xs font-medium uppercase text-muted-foreground">
                  Member
                </span>
              </TableHead>
              <TableHead>
                <PermissionsHeader policyRoles={availableRoles} />
              </TableHead>
              <TableHead className="w-24 pr-6"></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {[...Array(5)].map((_, i) => (
              <TableRow key={i}>
                <TableCell className="pl-6">
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
                <TableCell className="pr-6">
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
        <TableHeader className="bg-general-tertiary">
          <TableRow className="hover:bg-transparent">
            <TableHead className="w-12 pl-6">
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
              <PermissionsHeader policyRoles={availableRoles} />
            </TableHead>
            <TableHead className="w-24 pr-6"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {members.map((member) => {
            const validation = canModifyMember(member);

            return (
              <TableRow key={member.accountId} className="group">
                <TableCell className="pl-6">
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
                    {sortRolesByOrder(member.roles).map((role) => (
                      <RoleBadge key={role} role={role} variant="pill" showTooltip={false} />
                    ))}
                  </div>
                </TableCell>
                <TableCell className="pr-6">
                  <div className="flex justify-end gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                    <AuthButton
                      permissionKind="policy"
                      permissionAction="AddProposal"
                      balanceCheck={{ withProposalBond: true }}
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEditMember(member)}
                      disabled={hasPendingMemberRequest}
                      className="h-8 w-8"
                    >
                      <Pencil className="w-4 h-4" />
                    </AuthButton>
                    <AuthButton
                      permissionKind="policy"
                      permissionAction="AddProposal"
                      balanceCheck={{ withProposalBond: true }}
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        setMemberToDelete(member);
                        setIsDeleteModalOpen(true);
                      }}
                      disabled={hasPendingMemberRequest}
                      className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </AuthButton>
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
      <PageCard className="gap-0 p-0">
        {/* Hide header when members are selected */}
        {!(selectedMembers.length > 0) && (
          <div className="flex items-center justify-between pt-2 pb-2 px-6 border-b">
            <div className="flex items-center gap-3">
              <h2 className="font-semibold text-lg">Active Members</h2>
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted text-sm">
                {activeMembers.length}
              </span>
            </div>
            <div className="flex items-center gap-3">
              {/* Pending Button - navigates to requests page */}
              <Button
                type="button"
                onClick={() =>
                  router.push(`/${selectedTreasury}/requests?tab=pending`)
                }
                variant="ghost"
                className="flex items-center gap-2 border-2"
              >
                Pending
                <span className="flex h-6 w-6 items-center justify-center rounded-full bg-muted text-xs">
                  {pendingProposals?.proposals?.length || 0}
                </span>
              </Button>

              {/* Add New Member Button */}
              {isLoading ? (
                <div className="h-10 w-44 bg-muted rounded-lg animate-pulse" />
              ) : (
                <AuthButton
                  permissionKind="policy"
                  permissionAction="AddProposal"
                  balanceCheck={{ withProposalBond: true }}
                  onClick={handleOpenAddMemberModal}
                  disabled={hasPendingMemberRequest}
                  className="flex items-center gap-2 text-md"
                >
                  <span className="text-lg">+</span>
                  Add New Member
                </AuthButton>
              )}
            </div>
          </div>
        )}

        {/* Bulk Actions Bar */}
        {selectedMembers.length > 0 && (
          <div className="flex items-center justify-between pt-2 pb-2 px-6 border-b">
            <span className="font-semibold text-lg">
              {selectedMembers.length} member
              {selectedMembers.length !== 1 ? "s" : ""} selected
            </span>
            <div className="flex items-center gap-2">
              <Tooltip
                content={bulkDeleteValidation.reason}
                disabled={bulkDeleteValidation.canModify || !bulkDeleteValidation.reason}
                contentProps={{ className: "max-w-[280px]" }}
              >
                <span>
                  <AuthButton
                    permissionKind="policy"
                    permissionAction="AddProposal"
                    balanceCheck={{ withProposalBond: true }}
                    variant="outline"
                    size="sm"
                    onClick={handleBulkDelete}
                    disabled={hasPendingMemberRequest || !bulkDeleteValidation.canModify}
                    className="h-9 text-destructive hover:text-destructive hover:bg-destructive/10"
                  >
                    <Trash2 className="w-4 h-4 mr-1" />
                    Remove
                  </AuthButton>
                </span>
              </Tooltip>
              <AuthButton
                permissionKind="policy"
                permissionAction="AddProposal"
                balanceCheck={{ withProposalBond: true }}
                variant="outline"
                size="sm"
                onClick={handleBulkEdit}
                disabled={hasPendingMemberRequest}
                className="h-9"
              >
                <Pencil className="w-4 h-4 mr-1" />
                Edit
              </AuthButton>
            </div>
          </div>
        )}

        {/* Members Table */}
        {renderMembersTable(activeMembers)}
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
          setCurrentModalMode("add");
          setMembersBeingEdited([]);
          setOriginalMembersData([]);
        }}
        form={form}
        availableRoles={availableRoles}
        onReviewRequest={handleEditReviewRequest}
        isValidatingAddresses={false}
        mode="edit"
        originalMembers={originalMembersData}
      />

      {/* Edit Preview Modal */}
      <PreviewModal
        isOpen={isEditPreviewModalOpen}
        onClose={() => {
          setIsEditPreviewModalOpen(false);
          setSelectedMembers([]);
          setCurrentModalMode("add");
          setMembersBeingEdited([]);
        }}
        onBack={() => {
          setIsEditPreviewModalOpen(false);
          setIsEditRolesModalOpen(true);
        }}
        form={form}
        onSubmit={async () => {
          const membersData = form.getValues("members");
          await handleEditMembersSubmit(membersData);
        }}
        mode="edit"
        existingMembers={activeMembers}
        validationError={(() => {
          const membersData = form.watch("members");

          // Build edits array for validation
          const edits = membersData.map(
            (m: { accountId: string; roles: string[] }) => {
              const existingMember = activeMembers.find(
                (am) => am.accountId === m.accountId
              );
              return {
                accountId: m.accountId,
                oldRoles: existingMember?.roles || [],
                newRoles: m.roles,
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
