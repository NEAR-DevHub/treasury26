import { Proposal } from "@/lib/proposals-api";
import { decodeArgs, formatNearAmount } from "@/lib/utils";

interface FunctionCallExpandedProps {
  proposal: Proposal;
}

export function FunctionCallExpanded({ proposal }: FunctionCallExpandedProps) {
  if (!('FunctionCall' in proposal.kind)) return null;

  const functionCall = proposal.kind.FunctionCall;
  const receiver = functionCall.receiver_id;
  const actions = functionCall.actions;

  return (
    <div className="p-4 bg-muted/30 rounded-lg space-y-3">
      <h4 className="font-semibold text-sm">Function Call Details</h4>

      <div className="space-y-3">
        <div>
          <span className="text-muted-foreground text-sm">Receiver:</span>
          <p className="font-medium break-all">{receiver}</p>
        </div>

        <div>
          <span className="text-muted-foreground text-sm">Actions ({actions.length}):</span>
          <div className="space-y-2 mt-2">
            {actions.map((action, index) => (
              <div key={index} className="bg-background p-3 rounded border">
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-muted-foreground">Method:</span>
                    <p className="font-medium">{action.method_name}</p>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Deposit:</span>
                    <p className="font-medium">{formatNearAmount(action.deposit)} NEAR</p>
                  </div>

                  <div>
                    <span className="text-muted-foreground">Gas:</span>
                    <p className="font-medium">{action.gas}</p>
                  </div>

                  <div className="col-span-2">
                    <span className="text-muted-foreground">Arguments:</span>
                    <pre className="font-mono text-xs bg-muted p-2 rounded mt-1 overflow-x-auto">
                      {JSON.stringify(decodeArgs(action.args), null, 2)}
                    </pre>
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
