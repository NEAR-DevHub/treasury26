import { useState } from "react";
import { UseFormReturn, useFieldArray } from "react-hook-form";
import { X, ChevronDown, Trash2 } from "lucide-react";
import { Button } from "@/components/button";
import { RolePermission } from "@/types/policy";

interface AddMemberFormData {
  members: Array<{
    accountId: string;
    selectedRoles: string[];
  }>;
  approveWithVote: boolean;
}

interface AddMemberModalProps {
  isOpen: boolean;
  onClose: () => void;
  form: UseFormReturn<AddMemberFormData>;
  availableRoles: RolePermission[];
  onReviewRequest: () => void;
  isValidatingAddresses: boolean;
}

export function AddMemberModal({
  isOpen,
  onClose,
  form,
  availableRoles,
  onReviewRequest,
  isValidatingAddresses,
}: AddMemberModalProps) {
  const [expandedRoleDropdown, setExpandedRoleDropdown] = useState<
    number | null
  >(null);

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "members",
  });

  if (!isOpen) return null;

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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-lg shadow-xl max-w-2xl w-full max-h-[85vh] flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between p-6 pb-3 border-b-2">
          <h2 className="text-xl font-semibold">Add New Member</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1">
          <div className="bg-muted/50 rounded-lg p-4">
            {fields.map((field, index) => (
              <div key={field.id} className={index !== 0 ? "pt-4 border-t border-border" : ""}>
                <div className="flex items-center justify-between mb-2">
                  <label className="text-xs text-muted-foreground font-medium">
                    Member address
                  </label>
                  {fields.length > 1 && (
                    <button
                      type="button"
                      onClick={() => remove(index)}
                      className="text-muted-foreground hover:text-destructive transition-colors"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>

                <div className="flex items-start gap-3 mb-4">
                  <div className="flex-3 space-y-1">
                    <input
                      type="text"
                      {...form.register(`members.${index}.accountId`)}
                      placeholder="member.near"
                      className="w-full px-4 py-2.5 rounded-lg outline-none font-mono text-base"
                    />
                    {form.formState.errors.members?.[index]?.accountId && (
                      <p className="text-sm text-destructive">
                        {form.formState.errors.members[index]?.accountId?.message}
                      </p>
                    )}
                  </div>

                  <div className="flex-1 relative">
                    <button
                      type="button"
                      onClick={(e) => {
                        setExpandedRoleDropdown(
                          expandedRoleDropdown === index ? null : index
                        );
                      }}
                      className="w-full px-4 py-2.5 rounded-full bg-card flex items-center justify-between hover:bg-accent/50 transition-colors outline-none"
                    >
                      <span className="text-xs font-medium">
                        {(() => {
                          const roles = form.watch(`members.${index}.selectedRoles`) || [];
                          if (roles.length === 0) return "Select Role";
                          if (roles.length <= 2) return roles.join(", ");
                          return `${roles.length} roles`;
                        })()}
                      </span>
                      <ChevronDown className="w-4 h-4 ml-2" />
                    </button>

                    {expandedRoleDropdown === index && (
                      <>
                        <div
                          className="fixed inset-0"
                          onClick={() => setExpandedRoleDropdown(null)}
                        />
                        <div 
                          className="absolute top-full right-0 mt-1 bg-popover border border-border rounded-lg shadow-xl z-50 overflow-hidden min-w-[250px]"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {availableRoles.map((role) => (
                            <label
                              key={role.name}
                              className="flex items-center gap-3 px-4 py-2 hover:bg-muted/50 cursor-pointer"
                              onClick={(e) => e.stopPropagation()}
                            >
                              <input
                                type="checkbox"
                                checked={form.watch(`members.${index}.selectedRoles`)?.includes(role.name) || false}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  handleRoleToggle(index, role.name);
                                }}
                                className="w-4 h-4 rounded border-border accent-primary shrink-0"
                              />
                              <span className="text-sm font-medium">{role.name}</span>
                            </label>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                </div>
              </div>
            ))}

            <button
              type="button"
              onClick={() => append({ accountId: "", selectedRoles: [] })}
              className="flex items-center gap-2 text-foreground hover:text-muted-foreground transition-colors pt-4 border-t border-border w-full"
            >
              <span className="text-lg">+</span>
              <span className="font-medium">Add New Member</span>
            </button>
          </div>

         
         
        </div>

        {/* Footer */}
        <div className="p-6 pt-0">
          <Button
            type="button"
            onClick={onReviewRequest}
            disabled={!form.formState.isValid || isValidatingAddresses}
            className="w-full"
          >
            {isValidatingAddresses ? "Validating addresses..." : "Review Request"}
          </Button>
        </div>
      </div>
    </div>
  );
}

