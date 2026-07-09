import { useTranslations } from "next-intl";
import { useState } from "react";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
    DialogFooter,
} from "@/components/modal";
import { ButtonWithTooltip } from "@/components/button-with-tooltip";
import { NEARN_IO_ACCOUNT } from "../../constants";

interface Member {
    accountId: string;
    roles: string[];
}

interface DeleteConfirmationModalProps {
    isOpen: boolean;
    onClose: () => void;
    member: Member | null;
    members?: Member[];
    onConfirm: () => Promise<void>;
    validationError?: string;
}

export function DeleteConfirmationModal({
    isOpen,
    onClose,
    member,
    members,
    onConfirm,
    validationError,
}: DeleteConfirmationModalProps) {
    const t = useTranslations("members.removeDialog");
    const tCommon = useTranslations("common");
    const [isSubmitting, setIsSubmitting] = useState(false);

    const handleConfirm = async () => {
        setIsSubmitting(true);
        try {
            await onConfirm();
        } finally {
            setIsSubmitting(false);
        }
    };

    const membersToDelete =
        members && members.length > 0 ? members : member ? [member] : [];

    const isNearnAccountBeingDeleted = membersToDelete.some(
        (m) => m.accountId.toLowerCase() === NEARN_IO_ACCOUNT,
    );

    return (
        <Dialog
            open={isOpen && membersToDelete.length > 0}
            onOpenChange={(open) => !open && onClose()}
        >
            <DialogContent className="max-w-md gap-4">
                <DialogHeader>
                    <DialogTitle className="text-left">
                        {t("title")}
                    </DialogTitle>
                </DialogHeader>

                <DialogDescription>
                    {isNearnAccountBeingDeleted ? (
                        <span>
                            {t("nearnBody", { account: NEARN_IO_ACCOUNT })}
                        </span>
                    ) : (
                        <span>
                            {t.rich("genericBody", {
                                accounts: membersToDelete
                                    .map((m) => m.accountId)
                                    .join(", "),
                                bold: (chunks) => (
                                    <span className="font-semibold break-all overflow-wrap-anywhere text-wrap">
                                        {chunks}
                                    </span>
                                ),
                            })}
                        </span>
                    )}
                </DialogDescription>
                <DialogFooter>
                    <div className="w-full">
                        <ButtonWithTooltip
                            type="button"
                            onClick={handleConfirm}
                            variant="destructive"
                            className="w-full"
                            disabled={isSubmitting || !!validationError}
                            tooltipMessage={validationError}
                        >
                            {isSubmitting
                                ? t("creatingProposal")
                                : tCommon("remove")}
                        </ButtonWithTooltip>
                    </div>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
