"use client";

import { PageComponentLayout } from "@/components/page-component-layout";
import { TabGroup } from "@/components/tab-group";
import { Button } from "@/components/button";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useTreasury } from "@/stores/treasury-store";
import { useNear } from "@/stores/near-store";
import { useState, useMemo } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { isValidNearAddressFormat, validateNearAddress } from "@/lib/near-validation";
import { hasPermission } from "@/lib/config-utils";
import { useProposals } from "@/hooks/use-proposals";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { toast } from "sonner";
import { encodeToMarkdown } from "@/lib/utils";
import { MemberCard } from "./components/member-card";
import { AddMemberModal } from "./components/modals/add-member-modal";
import { PreviewModal } from "./components/modals/preview-modal";
import { EditRolesModal } from "./components/modals/edit-roles-modal";
import { DeleteConfirmationModal } from "./components/modals/delete-confirmation-modal";
import { PendingMemberCard } from "./components/pending-member-card";
import { EmptyMembersIcon } from "@/components/empty-state-icons";

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
  isNewMember?: boolean;
}

// Zod schema for form validation
const addMemberSchema = z.object({
  members: z
    .array(
      z.object({
        accountId: z
          .string()
          .min(1, "Account ID is required")
          .refine(isValidNearAddressFormat, {
            message: "Invalid NEAR address."
          }),
        selectedRoles: z
          .array(z.string())
          .min(1, "At least one role must be selected"),
      })
    )
    .min(1, "At least one member is required"),
  approveWithVote: z.boolean(),
});

type AddMemberFormData = z.infer<typeof addMemberSchema>;

export default function MembersPage() {
  const { selectedTreasury } = useTreasury();
  const { data: policy, isLoading } = useTreasuryPolicy(selectedTreasury);
  const { accountId } = useNear();
  const [activeTab, setActiveTab] = useState<"active" | "pending">("active");
  const [isAddMemberModalOpen, setIsAddMemberModalOpen] = useState(false);
  const [isPreviewModalOpen, setIsPreviewModalOpen] = useState(false);
  const [isEditRolesModalOpen, setIsEditRolesModalOpen] = useState(false);
  const [selectedMember, setSelectedMember] = useState<Member | null>(null);
  const [isValidatingAddresses, setIsValidatingAddresses] = useState(false);
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [memberToDelete, setMemberToDelete] = useState<Member | null>(null);

  // Fetch pending proposals to check for active member requests
  const { data: pendingProposals } = useProposals(selectedTreasury, {
    statuses: ["InProgress"],
    proposal_types:['ChangePolicy'],
    search:'members'
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

  // React Hook Form setup
  const form = useForm<AddMemberFormData>({
    resolver: zodResolver(addMemberSchema),
    mode: "onChange",
    defaultValues: {
      members: [{ accountId: "", selectedRoles: [] }],
      approveWithVote: false,
    },
  });

  // Extract unique members from policy roles
  const members = useMemo(() => {
    if (!policy?.roles) return [];

    const memberMap = new Map<string, Set<string>>();

    // Iterate through each role and extract members
    for (const role of policy.roles) {
      if (typeof role.kind === "object" && "Group" in role.kind) {
        // Group contains an array of account IDs
        const accountIds = role.kind.Group;
        for (const accountId of accountIds) {
          if (!memberMap.has(accountId)) {
            memberMap.set(accountId, new Set());
          }
          memberMap.get(accountId)?.add(role.name);
        }
      }
    }

    // Convert to array of Member objects
    return Array.from(memberMap.entries()).map(([accountId, rolesSet]) => ({
      accountId,
      roles: Array.from(rolesSet),
    }));
  }, [policy]);

  const activeMembers = members;
  
  // Extract pending members from proposal descriptions
  const pendingMembers = useMemo(() => {
    if (!pendingProposals?.proposals) return [];
    
    const pendingMembersList: PendingMember[] = [];
    
    for (const proposal of pendingProposals.proposals) {
      if (proposal.description) {
        const memberChanges = new Map<string, { addedRoles: Set<string>, removedRoles: Set<string> }>();
        
        // Parse "add" operations - NEW FORMAT: add "accountId" to ["Role1", "Role2"]
        const addPatternNew = /add "([^"]+)" to \[([^\]]+)\]/gi;
        let match;
        
        while ((match = addPatternNew.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const rolesStr = match[2];
          const roles = rolesStr.match(/"([^"]+)"/g)?.map(r => r.replace(/"/g, '')) || [];
          
          if (accountId) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, { addedRoles: new Set(), removedRoles: new Set() });
            }
            roles.forEach(role => memberChanges.get(accountId)?.addedRoles.add(role));
          }
        }
        
        // Parse "add" operations - OLD FORMAT: add "accountId" to "Role1" and "Role2" and "Role3"
        const addPatternOld = /add "([^"]+)" to "([^"]+)"(?: and "([^"]+)")*/gi;
        
        while ((match = addPatternOld.exec(proposal.description)) !== null) {
          const accountId = match[1];
          
          if (accountId) {
            // Extract all roles from the match
            const roles: string[] = [];
            for (let i = 2; i < match.length; i++) {
              if (match[i]) {
                roles.push(match[i]);
              }
            }
            
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, { addedRoles: new Set(), removedRoles: new Set() });
            }
            roles.forEach(role => memberChanges.get(accountId)?.addedRoles.add(role));
          }
        }
        
        // Parse "remove" operations - NEW FORMAT: remove "accountId" from ["Role1", "Role2"]
        const removePatternNew = /remove "([^"]+)" from \[([^\]]+)\]/gi;
        
        while ((match = removePatternNew.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const rolesStr = match[2];
          const roles = rolesStr.match(/"([^"]+)"/g)?.map(r => r.replace(/"/g, '')) || [];
          
          if (accountId) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, { addedRoles: new Set(), removedRoles: new Set() });
            }
            roles.forEach(role => memberChanges.get(accountId)?.removedRoles.add(role));
          }
        }
        
        // Parse "remove" operations - OLD FORMAT: remove "accountId" from "Role1"
        const removePatternOld = /remove "([^"]+)" from "([^"]+)"/gi;
        
        while ((match = removePatternOld.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const role = match[2];
          
          if (accountId && role) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, { addedRoles: new Set(), removedRoles: new Set() });
            }
            memberChanges.get(accountId)?.removedRoles.add(role);
          }
        }
        
        // Parse "edit" operations - NEW FORMAT: edit "accountId": removed from ["Role1"], added to ["Role2"]
        const editPatternNew = /edit "([^"]+)":\s*(?:removed from \[([^\]]+)\])?\s*,?\s*(?:added to \[([^\]]+)\])?/gi;
        
        while ((match = editPatternNew.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const removedRolesStr = match[2];
          const addedRolesStr = match[3];
          
          if (accountId) {
            if (!memberChanges.has(accountId)) {
              memberChanges.set(accountId, { addedRoles: new Set(), removedRoles: new Set() });
            }
            
            // Parse removed roles
            if (removedRolesStr) {
              const removedRoles = removedRolesStr.match(/"([^"]+)"/g)?.map(r => r.replace(/"/g, '')) || [];
              removedRoles.forEach(role => memberChanges.get(accountId)?.removedRoles.add(role));
            }
            
            // Parse added roles
            if (addedRolesStr) {
              const addedRoles = addedRolesStr.match(/"([^"]+)"/g)?.map(r => r.replace(/"/g, '')) || [];
              addedRoles.forEach(role => memberChanges.get(accountId)?.addedRoles.add(role));
            }
          }
        }
        
        // Parse "edit" operations - OLD FORMAT: edit "accountId" to ["Role1"] (for backwards compatibility)
        const editPatternOld = /edit "([^"]+)" to \[([^\]]+)\]/gi;
        
        while ((match = editPatternOld.exec(proposal.description)) !== null) {
          const accountId = match[1];
          const rolesStr = match[2];
          const newRoles = rolesStr.match(/"([^"]+)"/g)?.map(r => r.replace(/"/g, '')) || [];
          
          if (accountId) {
            // For edit, we need to compare with current roles to determine what was added/removed
            const currentMember = members.find(m => m.accountId === accountId);
            if (currentMember) {
              const currentRoles = new Set(currentMember.roles);
              const newRolesSet = new Set(newRoles);
              
              if (!memberChanges.has(accountId)) {
                memberChanges.set(accountId, { addedRoles: new Set(), removedRoles: new Set() });
              }
              
              // Added roles = in new but not in current
              newRoles.forEach(role => {
                if (!currentRoles.has(role)) {
                  memberChanges.get(accountId)?.addedRoles.add(role);
                }
              });
              
              // Removed roles = in current but not in new
              currentMember.roles.forEach(role => {
                if (!newRolesSet.has(role)) {
                  memberChanges.get(accountId)?.removedRoles.add(role);
                }
              });
            }
          }
        }
        
        // Convert map to array with proposal metadata
        for (const [accountId, changes] of memberChanges.entries()) {
          const currentMember = members.find(m => m.accountId === accountId);
          const isNewMember = !currentMember;
          const addedRoles = Array.from(changes.addedRoles);
          const removedRoles = Array.from(changes.removedRoles);
          
          // Only show if there are actual changes
          if (addedRoles.length > 0 || removedRoles.length > 0) {
            pendingMembersList.push({
              accountId,
              roles: addedRoles, // For display purposes, use added roles as primary
              proposalId: proposal.id,
              proposer: proposal.proposer,
              createdAt: proposal.submission_time,
              addedRoles,
              removedRoles,
              isNewMember,
            });
          }
        }
      }
    }
    
    return pendingMembersList;
  }, [pendingProposals, members]);

  const displayMembers = activeTab === "active" ? activeMembers : pendingMembers;

  const tabs = [
    { value: "active", label: "Active Members", count: activeMembers.length },
    { value: "pending", label: "Pending", count: pendingMembers.length },
  ];

  // Available roles from policy (excluding "all" role)
  const availableRoles = useMemo(() => {
    if (!policy?.roles) return [];
    return policy.roles.filter(
      (role) => typeof role.kind === "object" && "Group" in role.kind && role.name.toLowerCase() !== "all"
    );
  }, [policy]);

  // Helper function to check how many members have a specific role
  const getRoleMemberCount = (roleName: string): number => {
    return members.filter((member) => member.roles.includes(roleName)).length;
  };

  // Helper function to check if a member is the only one with a specific role
  const isOnlyMemberWithRole = (member: Member, roleName: string): boolean => {
    return member.roles.includes(roleName) && getRoleMemberCount(roleName) === 1;
  };

  // Check if member can be deleted (not the only one with any critical role)
  const canDeleteMember = (member: Member): { canDelete: boolean; reason?: string } => {
    // Collect all roles where this member is the only one
    const criticalRoles: string[] = [];
    
    for (const roleName of member.roles) {
      if (getRoleMemberCount(roleName) === 1) {
        criticalRoles.push(roleName);
      }
    }
    
    if (criticalRoles.length > 0) {
      // Check if any of them are governance roles
      const hasGovernance = criticalRoles.some(role => 
        role.toLowerCase().includes("governance") || role.toLowerCase().includes("admin")
      );
      
      // Format the roles list
      const rolesList = criticalRoles.length === 1 
        ? criticalRoles[0]
        : criticalRoles.length === 2
        ? `${criticalRoles[0]} and ${criticalRoles[1]}`
        : `${criticalRoles.slice(0, -1).join(", ")}, and ${criticalRoles[criticalRoles.length - 1]}`;
      
      const reason = hasGovernance
        ? `Cannot remove this member. They are the only person assigned to the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'}, which ${criticalRoles.length === 1 ? 'is' : 'are'} required to manage team members and configure voting.`
        : `Cannot remove this member. They are the only person assigned to the ${rolesList} ${criticalRoles.length === 1 ? 'role' : 'roles'}.`;
      
      return {
        canDelete: false,
        reason,
      };
    }
    
    return { canDelete: true };
  };

  const handleReviewRequest = async () => {
    const isValid = await form.trigger();
    if (!isValid) return;

    // Validate all addresses exist on blockchain
    setIsValidatingAddresses(true);
    const members = form.getValues("members");

    try {
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        const error = await validateNearAddress(member.accountId);

        if (error) {
          // Set error on the specific field
          form.setError(`members.${i}.accountId`, {
            type: "manual",
            message: error,
          });
          setIsValidatingAddresses(false);
          return;
        }
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

  const handleSubmitRequest = async () => {
    if (!policy || !selectedTreasury) return;

    const data = form.getValues();

    try {
      // Build summary for all members being added
      const summaryLines = data.members.map(({ accountId, selectedRoles }) => 
        `- add "${accountId}" to [${selectedRoles.map((r) => `"${r}"`).join(", ")}]`
      );
      const summary = summaryLines.join("\n");

      // Update policy with all new members
      const updatedPolicy = structuredClone(policy);
      updatedPolicy.roles = updatedPolicy.roles.map((role: any) => {
        const roleName = role.name;
        const existingGroup = [...(role.kind.Group || [])];
        
        // Add members who have this role
        data.members.forEach(({ accountId, selectedRoles }) => {
          if (selectedRoles.includes(roleName) && !existingGroup.includes(accountId)) {
            existingGroup.push(accountId);
          }
        });
        
        role.kind.Group = existingGroup;
        return role;
      });

      await createPolicyChangeProposal(
        updatedPolicy,
        summary,
        "Update Policy - Add New Members",
        "New member request created successfully"
      );

      setIsPreviewModalOpen(false);
      // Reset form
      form.reset({
        members: [{ accountId: "", selectedRoles: [] }],
        approveWithVote: false,
      });
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
    }
  };

  // Helper function to update policy for member role changes
  const updateDaoPolicyLocal = (memberAccountId: string, newRoles: string[], isEdit: boolean = true) => {
    if (!policy || !Array.isArray(policy.roles)) {
      return { updatedPolicy: policy, summary: "" };
    }

    let summaryLine = "";
    
    if (isEdit) {
      // For edit, calculate what's being added and removed
      const currentMember = members.find(m => m.accountId === memberAccountId);
      if (currentMember) {
        const currentRoles = new Set(currentMember.roles);
        const newRolesSet = new Set(newRoles);
        
        const addedRoles = newRoles.filter(r => !currentRoles.has(r));
        const removedRoles = currentMember.roles.filter(r => !newRolesSet.has(r));
        
        // Build descriptive summary showing both changes
        const parts: string[] = [];
        if (removedRoles.length > 0) {
          parts.push(`removed from [${removedRoles.map(r => `"${r}"`).join(", ")}]`);
        }
        if (addedRoles.length > 0) {
          parts.push(`added to [${addedRoles.map(r => `"${r}"`).join(", ")}]`);
        }
        
        summaryLine = `- edit "${memberAccountId}": ${parts.join(", ")}`;
      } else {
        // Fallback if member not found
        summaryLine = `- edit "${memberAccountId}" to [${newRoles.map((r) => `"${r}"`).join(", ")}]`;
      }
    } else {
      summaryLine = `- add "${memberAccountId}" to [${newRoles.map((r) => `"${r}"`).join(", ")}]`;
    }

    const updatedPolicy = structuredClone(policy);

    // Update roles
    updatedPolicy.roles = updatedPolicy.roles.map((role: any) => {
      const roleName = role.name;
      const shouldHaveRole = newRoles.includes(roleName);
      const currentGroup = [...(role.kind.Group || [])];
      const isInRole = currentGroup.includes(memberAccountId);

      if (shouldHaveRole && !isInRole) {
        // Add member to this role
        currentGroup.push(memberAccountId);
      } else if (!shouldHaveRole && isInRole) {
        // Remove member from this role
        const filteredGroup = currentGroup.filter((m) => m !== memberAccountId);
        role.kind.Group = filteredGroup;
        return role;
      }

      role.kind.Group = currentGroup;
      return role;
    });

    return { updatedPolicy, summary: summaryLine };
  };

  // Helper function to remove members from policy
  const removeMembersFromPolicy = (membersToRemove: Array<{ member: string; roles: string[] }>) => {
    if (!policy || !Array.isArray(policy.roles)) {
      return { updatedPolicy: policy, summary: "", emptyRoles: [] };
    }

    const emptyRoles: string[] = [];
    const summaryLines = membersToRemove.map(({ member, roles }) => {
      return `- remove "${member}" from [${roles.map((r) => `"${r}"`).join(", ")}]`;
    });

    const memberIdsToRemove = membersToRemove.map((m) => m.member);

    const updatedPolicy = structuredClone(policy);

    // Update roles
    updatedPolicy.roles.forEach((role: any) => {
      const originalGroup = role.kind.Group || [];
      role.kind.Group = originalGroup.filter((m: string) => !memberIdsToRemove.includes(m));

      // Check if this role would become empty
      if (originalGroup.length > 0 && role.kind.Group.length === 0) {
        emptyRoles.push(role.name);
      }
    });

    const summary = summaryLines.join("\n");
    return { updatedPolicy, summary, emptyRoles };
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
    } catch (error) {
      console.error("Failed to create proposal:", error);
      toast.error("Failed to create proposal");
      throw error;
    }
  };

  // Handle edit member roles submission
  const handleEditMemberSubmit = async (memberAccountId: string, newRoles: string[]) => {
    if (!policy || !selectedTreasury) return;

    try {
      const { updatedPolicy, summary } = updateDaoPolicyLocal(memberAccountId, newRoles, true);
      
      await createPolicyChangeProposal(
        updatedPolicy,
        summary,
        "Update Policy - Edit Member Permissions",
        "Member roles update request created successfully"
      );

      setIsEditRolesModalOpen(false);
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
      throw error;
    }
  };

  // Handle delete member submission
  const handleDeleteMemberSubmit = async () => {
    if (!policy || !selectedTreasury || !memberToDelete) return;

    try {
      const membersToRemove = [{
        member: memberToDelete.accountId,
        roles: memberToDelete.roles,
      }];

      const { updatedPolicy, summary } = removeMembersFromPolicy(membersToRemove);
      
      await createPolicyChangeProposal(
        updatedPolicy,
        summary,
        "Update Policy - Remove Member",
        "Member removal request created successfully"
      );

      setIsDeleteModalOpen(false);
      setMemberToDelete(null);
    } catch (error) {
      // Error already handled in createPolicyChangeProposal
    }
  };

  const handleOpenAddMemberModal = () => {
    form.reset({
      members: [{ accountId: "", selectedRoles: [] }],
      approveWithVote: false,
    });
    setIsAddMemberModalOpen(true);
  };

  const handleEditMember = (member: Member) => {
    setSelectedMember(member);
    setIsEditRolesModalOpen(true);
  };

  return (
    <PageComponentLayout
      title="Members"
      description="Manage team members and permissions"
    >
      <div className="space-y-6">
        {/* Header with tabs and Add button */}
        <div className="flex items-center justify-between">
          <TabGroup 
            tabs={tabs} 
            activeTab={activeTab} 
            onTabChange={(value) => setActiveTab(value as "active" | "pending")} 
          />

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
                    disabled={!accountId || !canAddMember || hasPendingMemberRequest}
                  >
                    <span className="text-lg">+</span>
                    Add New Member
                  </Button>
                </span>
              </TooltipTrigger>
              {(!accountId || !canAddMember || hasPendingMemberRequest) && (
                <TooltipContent className="max-w-[280px]">
                  <p>
                    {!accountId
                      ? "Sign in required"
                      : !canAddMember
                      ? "You don't have permission to add members"
                      : "You can't add, edit, or remove members while there is an active request. Please approve or reject the current request first."}
                  </p>
                </TooltipContent>
              )}
            </Tooltip>
          )}
        </div>

        {/* Members Grid */}
        {isLoading ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {[...Array(8)].map((_, i) => (
              <div key={i} className="rounded-lg border bg-card p-4 space-y-4 animate-pulse">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded w-3/4" />
                    <div className="h-3 bg-muted rounded w-1/2" />
                  </div>
                </div>
                <div className="space-y-2">
                  <div className="h-3 bg-muted rounded w-full" />
                  <div className="h-3 bg-muted rounded w-5/6" />
                </div>
                <div className="flex items-center justify-end gap-3 pt-3">
                  <div className="w-8 h-8 bg-muted rounded" />
                  <div className="w-20 h-9 bg-muted rounded-lg" />
                </div>
              </div>
            ))}
          </div>
        ) : displayMembers.length === 0 ? (
          <div className="rounded-lg border bg-card p-12 text-center">
            <div className="flex flex-col items-center gap-2">
              <EmptyMembersIcon />
              <p className="text-muted-foreground font-medium">
                {activeTab === "active"
                  ? "No active members found."
                  : "No pending requests."}
              </p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4" key={activeTab}>
            {activeTab === "active" ? (
              // Active members - show MemberCard with edit/delete
              (displayMembers as Member[]).map((member) => (
                <MemberCard 
                  key={member.accountId} 
                  member={member} 
                  onEdit={handleEditMember}
                  onDelete={(member) => {
                    setMemberToDelete(member);
                    setIsDeleteModalOpen(true);
                  }}
                  canDeleteMember={canDeleteMember}
                  hasPendingRequest={hasPendingMemberRequest}
                  hasPermission={canAddMember}
                  accountId={accountId}
                />
              ))
            ) : (
              // Pending members - show PendingMemberCard with proposal info
              (displayMembers as PendingMember[]).map((member) => (
                <PendingMemberCard
                  key={`${member.proposalId}-${member.accountId}`}
                  member={member}
                  proposalId={member.proposalId}
                  proposer={member.proposer}
                  createdAt={member.createdAt}
                  treasuryId={selectedTreasury}
                />
              ))
            )}
          </div>
        )}
      </div>

      {/* Add New Member Modal */}
      <AddMemberModal
        isOpen={isAddMemberModalOpen}
        onClose={() => setIsAddMemberModalOpen(false)}
        form={form}
        availableRoles={availableRoles}
        onReviewRequest={handleReviewRequest}
        isValidatingAddresses={isValidatingAddresses}
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
        onSubmit={handleSubmitRequest}
        policy={policy}
      />

      {/* Edit Roles Modal */}
      <EditRolesModal
        isOpen={isEditRolesModalOpen}
        onClose={() => setIsEditRolesModalOpen(false)}
        member={selectedMember}
        availableRoles={availableRoles}
        isOnlyMemberWithRole={isOnlyMemberWithRole}
        onSubmit={handleEditMemberSubmit}
      />

      {/* Delete Confirmation Modal */}
      <DeleteConfirmationModal
        isOpen={isDeleteModalOpen}
        onClose={() => {
          setIsDeleteModalOpen(false);
          setMemberToDelete(null);
        }}
        member={memberToDelete}
        onConfirm={handleDeleteMemberSubmit}
      />
    </PageComponentLayout>
  );
}