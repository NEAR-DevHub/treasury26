import { ChangePolicyData } from "../../types/index";

interface ChangePolicyExpandedProps {
  data: ChangePolicyData;
}

export function ChangePolicyExpanded({ data }: ChangePolicyExpandedProps) {
  const policy = data.policy;
  const roles = policy.roles;

  return (
    <div className="p-4 bg-muted/30 rounded-lg space-y-3">
      <h4 className="font-semibold text-sm">Policy Change Details</h4>

      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <span className="text-muted-foreground">Proposal Bond:</span>
            <p className="font-medium">{policy.proposal_bond}</p>
          </div>

          <div>
            <span className="text-muted-foreground">Proposal Period:</span>
            <p className="font-medium">{policy.proposal_period}</p>
          </div>
        </div>

        <div>
          <span className="text-muted-foreground text-sm">Roles ({roles.length}):</span>
          <div className="space-y-2 mt-2">
            {roles.map((role, index) => (
              <div key={index} className="bg-background p-3 rounded border">
                <div className="space-y-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Name:</span>
                    <p className="font-semibold">{role.name}</p>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Members:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {"Group" in role.kind && role.kind.Group.map((member, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 bg-muted rounded text-xs font-medium"
                        >
                          {member}
                        </span>
                      ))}
                    </div>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Permissions:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {role.permissions.slice(0, 3).map((permission, idx) => (
                        <span
                          key={idx}
                          className="px-2 py-1 bg-primary/10 text-primary rounded text-xs"
                        >
                          {permission}
                        </span>
                      ))}
                      {role.permissions.length > 3 && (
                        <span className="px-2 py-1 bg-muted rounded text-xs">
                          +{role.permissions.length - 3} more
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
