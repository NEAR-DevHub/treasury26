"use client";

import { useRouter } from "next/navigation";
/**
 * Author a new proposal template: the shared TemplateEditor (Visual constructor by default, with a
 * Code tab for raw manifest JSON) validates live, then saves via the `ChangePolicy`-gated create
 * endpoint. Lives at the reserved `create` slug.
 */
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { PageComponentLayout } from "@/components/page-component-layout";
import { apiErrorMessage } from "@/features/proposal-templates/api";
import { TemplateEditor } from "@/features/proposal-templates/components/template-editor";
import { useCreateProposalTemplate } from "@/features/proposal-templates/hooks/use-proposal-template-mutations";
import { manifestIdOf } from "@/features/proposal-templates/manifest";
import { useTreasury } from "@/hooks/use-treasury";

export default function CreateTemplatePage() {
    const t = useTranslations("customTemplates");
    const router = useRouter();
    const { treasuryId } = useTreasury();
    const createTemplate = useCreateProposalTemplate();

    async function handleCreate({
        name,
        manifest,
    }: {
        name: string;
        manifest: unknown;
    }) {
        if (!treasuryId) {
            return;
        }
        try {
            const created = await createTemplate.mutateAsync({
                name,
                manifest,
            });
            toast.success(t("create.toastCreated"));
            router.push(
                `/${treasuryId}/custom-templates/${manifestIdOf(created.manifest)}`,
            );
        } catch (error) {
            toast.error(apiErrorMessage(error, t("create.errCreate")));
        }
    }

    return (
        <PageComponentLayout
            title={t("pageTitle")}
            description={t("pageDescription")}
        >
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
                <TemplateEditor
                    title={t("create.title")}
                    onBack={() =>
                        router.push(`/${treasuryId}/custom-templates`)
                    }
                    submitLabel={t("create.submit")}
                    submittingLabel={t("create.submitting")}
                    submitting={createTemplate.isPending}
                    onSubmit={handleCreate}
                />
            </div>
        </PageComponentLayout>
    );
}
