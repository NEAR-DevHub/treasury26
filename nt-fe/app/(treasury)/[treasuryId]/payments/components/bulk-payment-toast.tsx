import { Icon } from "@/components/icon";
import {
    CheckmarkCircle01Icon,
    Loading02Icon,
} from "@hugeicons/core-free-icons";

interface Step {
    label: string;
    status: "pending" | "loading" | "completed";
}

interface BulkPaymentToastProps {
    steps: Step[];
}

export function BulkPaymentToast({ steps }: BulkPaymentToastProps) {
    return (
        <div className="space-y-2">
            {steps.map((step, index) => (
                <div
                    key={index}
                    className={`flex items-center gap-2 ${
                        step.status === "pending" ? "text-muted-foreground" : ""
                    }`}
                >
                    {step.status === "completed" ? (
                        <Icon
                            icon={CheckmarkCircle01Icon}
                            className="text-general-success-foreground shrink-0"
                        />
                    ) : step.status === "loading" ? (
                        <Icon
                            icon={Loading02Icon}
                            className="animate-spin shrink-0"
                        />
                    ) : (
                        <div className="w-4 h-4 shrink-0" />
                    )}
                    <span className="text-sm">
                        {index + 1}/{steps.length} {step.label}
                    </span>
                </div>
            ))}
        </div>
    );
}
