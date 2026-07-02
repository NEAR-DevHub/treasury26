"use client";

import { useParams, useRouter } from "next/navigation";
/**
 * Edit or delete an existing template. Reuses TemplateEditor (Visual constructor by default, Code
 * tab for raw JSON) pre-filled with the template's current name + manifest, saving via the
 * `ChangePolicy`-gated update endpoint. Delete is confirmed in a dialog and returns to the index. A
 * non-author hitting save/delete gets the backend's 403 as a toast.
 */
import { useTranslations } from "next-intl";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from "@/components/modal";
import { PageComponentLayout } from "@/components/page-component-layout";
import { apiErrorMessage } from "@/features/proposal-templates/api";
import { TemplateEditor } from "@/features/proposal-templates/components/template-editor";
import {
    useDeleteProposalTemplate,
    useUpdateProposalTemplate,
} from "@/features/proposal-templates/hooks/use-proposal-template-mutations";
import { useProposalTemplates } from "@/features/proposal-templates/hooks/use-proposal-templates";
import { manifestIdOf } from "@/features/proposal-templates/manifest";
import { useTreasury } from "@/hooks/use-treasury";

export default function EditTemplatePage() {
    const t = useTranslations("customTemplates");
    const router = useRouter();
    const params = useParams();
    const slug = params?.slug as string | undefined;
    const { treasuryId } = useTreasury();
    const { data: templates, isLoading } = useProposalTemplates();
    const updateTemplate = useUpdateProposalTemplate();
    const deleteTemplate = useDeleteProposalTemplate();
    const [confirmingDelete, setConfirmingDelete] = useState(false);

    const template = (templates ?? []).find(
        (candidate) => manifestIdOf(candidate.manifest) === slug,
    );

    async function handleUpdate({
        name,
        manifest,
    }: {
        name: string;
        manifest: unknown;
    }) {
        if (!template || !treasuryId) {
            return;
        }
        try {
            const updated = await updateTemplate.mutateAsync({
                id: template.id,
                input: { name, manifest },
            });
            toast.success(t("edit.toastSaved"));
            router.push(
                `/${treasuryId}/custom-templates/${manifestIdOf(updated.manifest)}`,
            );
        } catch (error) {
            toast.error(apiErrorMessage(error, t("edit.errSave")));
        }
    }

    async function handleDelete() {
        if (!template || !treasuryId) {
            return;
        }
        setConfirmingDelete(false);
        try {
            await deleteTemplate.mutateAsync(template.id);
            toast.success(t("toastDeleted"));
            router.push(`/${treasuryId}/custom-templates`);
        } catch (error) {
            toast.error(apiErrorMessage(error, t("errDelete")));
        }
    }

    return (
        <PageComponentLayout
            title={t("pageTitle")}
            description={t("pageDescription")}
        >
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
                {isLoading ? (
                    <PageCard>
                        <p className="text-muted-foreground text-sm">
                            {t("loading")}
                        </p>
                    </PageCard>
                ) : template ? (
                    <TemplateEditor
                        key={template.id}
                        title={t("edit.title")}
                        onBack={() =>
                            router.push(`/${treasuryId}/custom-templates`)
                        }
                        initialName={template.name}
                        initialManifestText={JSON.stringify(
                            template.manifest,
                            null,
                            2,
                        )}
                        submitLabel={t("edit.submit")}
                        submitting={updateTemplate.isPending}
                        onSubmit={handleUpdate}
                        footer={
                            <Button
                                type="button"
                                variant="ghost"
                                className="w-full text-destructive hover:text-destructive"
                                disabled={
                                    updateTemplate.isPending ||
                                    deleteTemplate.isPending
                                }
                                onClick={() => setConfirmingDelete(true)}
                            >
                                {t("edit.deleteButton")}
                            </Button>
                        }
                    />
                ) : (
                    <PageCard>
                        <p className="text-muted-foreground text-sm">
                            {t("edit.notFound")}
                        </p>
                    </PageCard>
                )}
            </div>

            <Dialog
                open={confirmingDelete}
                onOpenChange={(open) => !open && setConfirmingDelete(false)}
            >
                <DialogContent className="max-w-md gap-4">
                    <DialogHeader>
                        <DialogTitle>{t("deleteDialog.title")}</DialogTitle>
                    </DialogHeader>
                    <DialogDescription>
                        {t.rich("deleteDialog.body", {
                            name: template?.name ?? "",
                            b: (chunks) => (
                                <span className="font-semibold">{chunks}</span>
                            ),
                        })}
                    </DialogDescription>
                    <DialogFooter>
                        <Button
                            variant="destructive"
                            className="flex-1"
                            disabled={deleteTemplate.isPending}
                            onClick={handleDelete}
                        >
                            {deleteTemplate.isPending
                                ? t("deleteDialog.deleting")
                                : t("deleteDialog.confirm")}
                        </Button>
                    </DialogFooter>
                </DialogContent>
            </Dialog>
        </PageComponentLayout>
    );
}
