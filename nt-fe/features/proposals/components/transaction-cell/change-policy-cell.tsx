import { ChangePolicyData } from "../../types/index";

interface ChangePolicyCellProps {
  data: ChangePolicyData;
}

export function ChangePolicyCell({ data }: ChangePolicyCellProps) {
  return (
    <div className="flex flex-col gap-1">
      <span className="font-medium">Policy Update</span>
      <span className="text-xs text-muted-foreground">
        {data.rolesCount} role{data.rolesCount !== 1 ? 's' : ''} configured
      </span>
    </div>
  );
}
