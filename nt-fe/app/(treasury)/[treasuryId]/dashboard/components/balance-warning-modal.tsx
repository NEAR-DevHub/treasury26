"use client";

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { parseWarningCopy } from "@/components/warning-message";
import { useWarningMessage } from "@/hooks/use-warnings";
import { useWarnings } from "@/hooks/use-warnings";

/**
 * Shows a one-time-per-session modal when balances are temporarily
 * unavailable (`data.balances` warning). After dismissal the persistent
 * banner in the sidebar keeps the user informed.
 */
export function BalanceWarningModal() {
    const t = useTranslations("proposals.insufficientBalance");
    const { getWarning } = useWarnings();
    const warning = getWarning("data.balances");
    const message = useWarningMessage(warning, "data.balances");
    const [open, setOpen] = useState(false);

    const warningId = warning?.id ?? null;
    const { heading, body } = useMemo(
        () => parseWarningCopy(message),
        [message],
    );

    useEffect(() => {
        if (warningId == null) {
            setOpen(false);
            return;
        }
        if (typeof window === "undefined") return;
        const dismissed = sessionStorage.getItem(
            `balance-warning-dismissed-${warningId}`,
        );
        if (!dismissed) {
            setOpen(true);
        }
    }, [warningId]);

    if (!message) return null;

    const handleClose = () => {
        setOpen(false);
        if (typeof window !== "undefined" && warningId != null) {
            sessionStorage.setItem(
                `balance-warning-dismissed-${warningId}`,
                "1",
            );
        }
    };

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) handleClose();
            }}
        >
            <DialogContent>
                <DialogHeader>
                    <DialogTitle>{heading}</DialogTitle>
                </DialogHeader>
                {body && <DialogDescription>{body}</DialogDescription>}
                <DialogFooter>
                    <Button className="w-full" onClick={handleClose}>
                        {t("gotIt")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
