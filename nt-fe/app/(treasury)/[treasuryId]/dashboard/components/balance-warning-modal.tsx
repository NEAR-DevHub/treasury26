"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { useWarnings } from "@/hooks/use-warnings";

/**
 * Shows a one-time-per-session modal when balances are temporarily
 * unavailable (`data.balances` warning). After dismissal the persistent inline
 * banner on the dashboard keeps the user informed.
 */
export function BalanceWarningModal() {
    const { getWarning } = useWarnings();
    const warning = getWarning("data.balances");
    const [open, setOpen] = useState(false);

    const warningId = warning?.id ?? null;

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

    if (!warning?.message) return null;

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
                    <DialogTitle>Balance temporarily unavailable</DialogTitle>
                </DialogHeader>
                <DialogDescription>{warning.message}</DialogDescription>
                <DialogFooter>
                    <Button className="w-full" onClick={handleClose}>
                        Got it
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
