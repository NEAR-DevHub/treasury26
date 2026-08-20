"use client";
import { Icon } from "@/components/icon";
import {
    Cancel01Icon,
    Loading02Icon,
    Tick01Icon,
} from "@hugeicons/core-free-icons";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";

export interface CreationStep {
    id: string;
    label: string;
    status: "pending" | "in_progress" | "completed" | "error";
}

interface CreationProgressModalProps {
    open: boolean;
    steps: CreationStep[];
    error?: string | null;
    treasuryId?: string | null;
    onClose: () => void;
}

function StepStatusIcon({ status }: { status: CreationStep["status"] }) {
    switch (status) {
        case "completed":
            return (
                <div className="flex shrink-0 items-center justify-center rounded-full bg-general-success-foreground size-6">
                    <Icon icon={Tick01Icon} className="text-white" />
                </div>
            );
        case "in_progress":
            return (
                <div className="flex shrink-0 items-center justify-center size-6">
                    <Icon
                        icon={Loading02Icon}
                        className="text-foreground animate-spin"
                    />
                </div>
            );
        case "error":
            return (
                <div className="flex shrink-0 items-center justify-center rounded-full bg-general-destructive-foreground size-6">
                    <Icon icon={Cancel01Icon} className="text-white" />
                </div>
            );
        default:
            return (
                <div className="flex shrink-0 items-center justify-center rounded-full border border-muted-foreground/20 bg-card size-6" />
            );
    }
}

export function CreationProgressModal({
    open,
    steps,
    error,
    treasuryId,
    onClose,
}: CreationProgressModalProps) {
    const t = useTranslations("progressModal");
    const isDone = !!treasuryId;
    const hasError = !!error;

    return (
        <Dialog
            open={open}
            onOpenChange={(nextOpen) => {
                if (!nextOpen && (hasError || isDone)) {
                    onClose();
                }
            }}
        >
            <DialogContent className="max-w-md!">
                <DialogHeader closeButton={hasError || isDone}>
                    <DialogTitle>
                        {hasError
                            ? t("titleFailed")
                            : isDone
                              ? t("titleDone")
                              : t("titleCreating")}
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-3 py-2">
                    {steps.map((step, index) => (
                        <div key={step.id} className="flex items-center gap-3">
                            <StepStatusIcon status={step.status} />
                            <span
                                className={cn(
                                    "text-sm",
                                    step.status === "pending" &&
                                        "text-muted-foreground",
                                    step.status === "in_progress" &&
                                        "text-foreground font-medium",
                                    step.status === "completed" &&
                                        "text-muted-foreground",
                                    step.status === "error" &&
                                        "text-general-destructive-foreground font-medium",
                                )}
                            >
                                {step.label}
                            </span>
                        </div>
                    ))}
                </div>

                {hasError && (
                    <p className="text-sm text-general-destructive-foreground">
                        {error}
                    </p>
                )}
            </DialogContent>
        </Dialog>
    );
}
