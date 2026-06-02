"use client";

import { Check, Loader2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { Button } from "@/components/button";
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
    onNavigate: () => void;
    onClose: () => void;
}

function StepStatusIcon({ status }: { status: CreationStep["status"] }) {
    switch (status) {
        case "completed":
            return (
                <div className="flex shrink-0 items-center justify-center rounded-full bg-general-success-foreground size-6">
                    <Check className="size-4 text-white" />
                </div>
            );
        case "in_progress":
            return (
                <div className="flex shrink-0 items-center justify-center size-6">
                    <Loader2 className="size-5 text-foreground animate-spin" />
                </div>
            );
        case "error":
            return (
                <div className="flex shrink-0 items-center justify-center rounded-full bg-general-destructive-foreground size-6">
                    <X className="size-4 text-white" />
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
    onNavigate,
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

                {isDone && (
                    <Button className="w-full mt-2" onClick={onNavigate}>
                        {t("viewTreasury")}
                    </Button>
                )}
            </DialogContent>
        </Dialog>
    );
}
