import { useState } from "react";
import { UseFormReturn, useFieldArray } from "react-hook-form";
import { ChevronDown, Trash2, Plus } from "lucide-react";
import { Button } from "@/components/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/modal";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { RolePermission } from "@/types/policy";

interface MemberFormData {
  members: Array<{
    accountId: string;
    selectedRoles: string[];
  }>;
}

interface MemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  form: UseFormReturn<MemberFormData>;
  availableRoles: RolePermission[];
  onReviewRequest: () => void;
  isValidatingAddresses: boolean;
  mode: "add" | "edit";
  existingMember?: {
    accountId: string;
    roles: string[];
  } | null;
  validationError?: string;
}

export function MemberModal({
  isOpen,
  onClose,
  form,
  availableRoles,
  onReviewRequest,
  isValidatingAddresses,
  mode,
  existingMember,
  validationError,
}: MemberModalProps) {
  const [expandedRoleDropdown, setExpandedRoleDropdown] = useState<
    number | null
  >(null);

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "members",
  });

  const handleRoleToggle = (memberIndex: number, roleName: string) => {
    const currentRoles = form.getValues(`members.${memberIndex}.selectedRoles`);
    const hasRole = currentRoles.includes(roleName);

    form.setValue(
      `members.${memberIndex}.selectedRoles`,
      hasRole
        ? currentRoles.filter((r) => r !== roleName)
        : [...currentRoles, roleName],
      { shouldValidate: true, shouldDirty: true, shouldTouch: true }
    );
  };

  // Get display text for role selector
  const getRoleDisplayText = (roles: string[]) => {
    if (roles.length === 0) return "Select Role";
    if (roles.length === availableRoles.length) return "Full Access";
    if (roles.length <= 2) return roles.join(", ");
    return `${roles.length} roles`;
  };

  const isEditMode = mode === "edit";
  const memberCount = fields.length;
  const title = isEditMode
    ? memberCount > 1
      ? `Edit ${memberCount} Members`
      : "Edit Roles"
    : "Add New Member";
  const buttonText = isValidatingAddresses
    ? isEditMode
      ? "Creating proposal..."
      : "Validating addresses..."
    : isEditMode
    ? "Confirm Changes"
    : "Review Request";

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => !open && !isValidatingAddresses && onClose()}
    >
      <DialogContent className="max-w-2xl max-h-[85vh] flex flex-col p-0 gap-4">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>

        <div className="overflow-y-auto flex-1 px-4">
          <div className="bg-muted/50 rounded-lg p-4">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className={index !== 0 ? "pt-4 border-t border-border" : ""}
              >
                <div className="flex items-center justify-between mb-2">
                  <Label className="text-xs text-muted-foreground font-medium">
                    Member address
                  </Label>
                  {fields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => remove(index)}
                      className="h-auto p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  )}
                </div>

                <div className="flex items-start gap-3 mb-4">
                  <div className="flex-3 space-y-1">
                    {isEditMode ? (
                      <div className="w-full py-2.5 rounded-lg font-mono text-base text-muted-foreground break-all">
                        {form.watch(`members.${index}.accountId`)}
                      </div>
                    ) : (
                      <>
                        <div
                          className="w-full px-4 py-2.5 rounded-lg cursor-text"
                          onClick={(e) => {
                            const input =
                              e.currentTarget.querySelector("input");
                            input?.focus();
                          }}
                        >
                          <Input
                            type="text"
                            {...form.register(`members.${index}.accountId`)}
                            placeholder="member.near"
                            className="font-mono border-0 bg-transparent p-0 h-auto shadow-none focus-visible:ring-0 focus-visible:ring-offset-0"
                          />
                        </div>
                        {form.formState.errors.members?.[index]?.accountId && (
                          <p className="text-sm text-destructive">
                            {
                              form.formState.errors.members[index]?.accountId
                                ?.message
                            }
                          </p>
                        )}
                      </>
                    )}
                  </div>

                  <div className="flex-1">
                    <Popover
                      open={expandedRoleDropdown === index}
                      onOpenChange={(open) =>
                        setExpandedRoleDropdown(open ? index : null)
                      }
                    >
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          className="w-full justify-between bg-card rounded-full"
                        >
                          <span className="text-xs font-medium">
                            {getRoleDisplayText(
                              form.watch(`members.${index}.selectedRoles`) || []
                            )}
                          </span>
                          <ChevronDown className="w-4 h-4 ml-2 shrink-0" />
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-64 p-0" align="end">
                        <div className="space-y-1 p-2">
                          {availableRoles.map((role) => (
                            <label
                              key={role.name}
                              className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 cursor-pointer"
                            >
                              <Checkbox
                                checked={
                                  form
                                    .watch(`members.${index}.selectedRoles`)
                                    ?.includes(role.name) || false
                                }
                                onCheckedChange={() =>
                                  handleRoleToggle(index, role.name)
                                }
                              />
                              <span className="text-sm font-medium">
                                {role.name}
                              </span>
                            </label>
                          ))}
                        </div>
                      </PopoverContent>
                    </Popover>
                  </div>
                </div>
              </div>
            ))}

            {!isEditMode && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => append({ accountId: "", selectedRoles: [] })}
                className="flex items-center gap-2 pt-4 border-t border-border w-full justify-start"
              >
                <Plus className="w-5 h-5" />
                <span className="font-medium">Add New Member</span>
              </Button>
            )}
          </div>
        </div>

        <div className="p-6 pt-4 pb-4 border-t border-border shrink-0">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="block">
                <Button
                  type="button"
                  onClick={onReviewRequest}
                  disabled={
                    !form.formState.isValid ||
                    isValidatingAddresses ||
                    !!validationError
                  }
                  className="w-full"
                >
                  {buttonText}
                </Button>
              </span>
            </TooltipTrigger>
            {validationError && (
              <TooltipContent className="max-w-[280px]">
                <p>{validationError}</p>
              </TooltipContent>
            )}
          </Tooltip>
        </div>
      </DialogContent>
    </Dialog>
  );
}
