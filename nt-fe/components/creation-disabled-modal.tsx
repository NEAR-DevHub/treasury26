"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/button";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { submitWhitelistRequest } from "@/lib/api";
import { isValidWaitlistContact } from "@/lib/waitlist-contact-validation";
import { useNear } from "@/stores/near-store";
import { Input } from "./input";

interface CreationDisabledModalProps {
    open: boolean;
    onClose: () => void;
}

export function CreationDisabledModal({
    open,
    onClose,
}: CreationDisabledModalProps) {
    const tL = useTranslations("landing");
    const tP = useTranslations("progressModal");
    const tI = useTranslations("proposals.insufficientBalance");
    const { accountId } = useNear();
    const [contact, setContact] = useState("");
    const [isSubmitting, setIsSubmitting] = useState(false);
    const [submitted, setSubmitted] = useState(false);

    const trimmedContact = contact.trim();
    const showContactError =
        trimmedContact.length > 0 && !isValidWaitlistContact(contact);
    const canSubmit =
        trimmedContact.length > 0 && isValidWaitlistContact(contact);

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setIsSubmitting(true);
        try {
            await submitWhitelistRequest({
                contact: trimmedContact,
                accountId: accountId ?? undefined,
            });
            setSubmitted(true);
        } catch {
            toast.error(tL("waitlistSubmitFailed"));
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleOpenChange = (o: boolean) => {
        if (!o) {
            onClose();
            setContact("");
            setSubmitted(false);
        }
    };

    return (
        <Dialog open={open} onOpenChange={handleOpenChange}>
            <DialogContent className="max-w-md!">
                <DialogHeader>
                    <DialogTitle>
                        {submitted
                            ? tL("waitlistSubmittedTitle")
                            : tL("waitlistTitle")}
                    </DialogTitle>
                </DialogHeader>
                {submitted ? (
                    <>
                        <p className="text-sm text-muted-foreground">
                            {tL("waitlistSubmittedDescription")}
                        </p>
                        <Button className="w-full mt-3" onClick={onClose}>
                            {tI("gotIt")}
                        </Button>
                    </>
                ) : (
                    <div className="flex flex-col gap-3">
                        <p className="text-sm text-muted-foreground">
                            {tL("waitlistDescription")}
                        </p>
                        <div className="flex flex-col gap-1">
                            <Input
                                type="text"
                                placeholder={tL("waitlistInputPlaceholder")}
                                value={contact}
                                onChange={(e) => setContact(e.target.value)}
                            />
                            {showContactError ? (
                                <p className="text-xs text-destructive">
                                    {tL("waitlistInvalidContact")}
                                </p>
                            ) : (
                                <p className="text-xs text-muted-foreground">
                                    {tL("waitlistPrivacyNote")}
                                </p>
                            )}
                        </div>
                        <Button
                            className="w-full"
                            onClick={handleSubmit}
                            disabled={isSubmitting || !canSubmit}
                        >
                            {isSubmitting && (
                                <Loader2 className="h-4 w-4 animate-spin" />
                            )}
                            {tL("waitlistSubmit")}
                        </Button>
                    </div>
                )}
            </DialogContent>
        </Dialog>
    );
}
