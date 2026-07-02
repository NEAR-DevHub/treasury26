"use client";

/**
 * Per-template page: `/<dao>/custom-templates/<slug>` where `<slug>` is the manifest id. Resolves
 * the template, renders its manifest as a form (`<ManifestForm>`), and on submit builds the
 * FunctionCall (`buildTemplateProposal`) and files it via the house `createProposal` helper — the
 * same gasless-relayer route the core proposals use, so a custom request behaves like a built-in one.
 */
import { ArrowLeft } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { PageCard } from "@/components/card";
import { PageComponentLayout } from "@/components/page-component-layout";
import {
    buildTemplateProposal,
    type FieldValues,
} from "@/features/proposal-templates/build-proposal";
import { ManifestForm } from "@/features/proposal-templates/components/manifest-form";
import { useProposalTemplates } from "@/features/proposal-templates/hooks/use-proposal-templates";
import {
    manifestErrorMessages,
    manifestIdOf,
    parseManifest,
} from "@/features/proposal-templates/manifest";
import { useTreasury } from "@/hooks/use-treasury";
import { useTreasuryPolicy } from "@/hooks/use-treasury-queries";
import { useNear } from "@/stores/near-store";

export default function CustomTemplatePage() {
    const t = useTranslations("customTemplates");
    const params = useParams();
    const router = useRouter();
    const slug = params?.slug as string | undefined;
    const { treasuryId } = useTreasury();
    // Files through the house `createProposal` helper — the same gasless-relayer path the core
    // proposals (payments, exchange, members…) use: it signs the `add_proposal` delegate action,
    // relays it via the backend, waits for the indexer, invalidates the requests list, and shows the
    // rich "View request" toast. So a custom request behaves exactly like a built-in one.
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const { data: templates, isLoading } = useProposalTemplates();
    const [submitting, setSubmitting] = useState(false);

    const template = templates?.find(
        (candidate) => manifestIdOf(candidate.manifest) === slug,
    );
    const parsed = template ? parseManifest(template.manifest) : null;
    const templateTitle = parsed?.success ? parsed.data.title : null;

    // The section layout titles the tab "Request Templates"; on a specific template show its own
    // name instead (the layout's "%s | Trezu" template doesn't apply to a client-set document.title,
    // so add the suffix here). Restore the previous title on unmount, like the receipt page.
    useEffect(() => {
        if (typeof document === "undefined" || !templateTitle) {
            return;
        }
        const previousTitle = document.title;
        document.title = `${templateTitle} | Trezu`;
        return () => {
            document.title = previousTitle;
        };
    }, [templateTitle]);

    // `createProposal` already gates on a full session (toasts the localized "connect + accept terms"
    // message and throws) and toasts its own relayer errors — so we don't pre-check or re-toast. The
    // throw propagating out is what lets ManifestForm skip its clear-on-success path on failure.
    async function handleSubmit(values: FieldValues) {
        if (!parsed?.success || !treasuryId) {
            return;
        }
        setSubmitting(true);
        try {
            const { kind, description } = buildTemplateProposal(
                parsed.data,
                values,
            );
            await createProposal(t("fill.proposalFiled"), {
                treasuryId,
                proposal: { description, kind },
                proposalBond: policy?.proposal_bond ?? "0",
                proposalType: "other",
            });
        } finally {
            setSubmitting(false);
        }
    }

    return (
        <PageComponentLayout
            title={t("pageTitle")}
            description={t("pageDescription")}
        >
            <div className="mx-auto flex w-full max-w-[600px] flex-col gap-4">
                {isLoading ? (
                    <PageCard>
                        <p className="text-muted-foreground text-sm">
                            {t("loading")}
                        </p>
                    </PageCard>
                ) : !template ? (
                    <PageCard>
                        <p className="text-muted-foreground text-sm">
                            {t("fill.noTemplate", { slug: slug ?? "" })}
                        </p>
                    </PageCard>
                ) : parsed && !parsed.success ? (
                    <PageCard>
                        <div className="text-destructive text-sm">
                            <p>{t("fill.invalidManifest")}</p>
                            <ul className="list-disc pl-5">
                                {manifestErrorMessages(parsed.error).map(
                                    (message) => (
                                        <li key={message}>{message}</li>
                                    ),
                                )}
                            </ul>
                        </div>
                    </PageCard>
                ) : parsed?.success ? (
                    <PageCard className="gap-4">
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() =>
                                    router.push(
                                        `/${treasuryId}/custom-templates`,
                                    )
                                }
                                aria-label={t("back")}
                                className="text-muted-foreground transition-colors hover:text-foreground"
                            >
                                <ArrowLeft className="size-5" />
                            </button>
                            <h2 className="font-semibold text-base">
                                {parsed.data.title}
                            </h2>
                        </div>
                        {parsed.data.description ? (
                            <p className="text-muted-foreground text-sm">
                                {parsed.data.description}
                            </p>
                        ) : null}
                        <ManifestForm
                            manifest={parsed.data}
                            onSubmit={handleSubmit}
                            submitting={submitting}
                        />
                    </PageCard>
                ) : null}
            </div>
        </PageComponentLayout>
    );
}
