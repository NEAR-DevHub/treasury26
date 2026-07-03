"use client";

/**
 * Index for the Request Templates section: the empty state (no templates yet) or the Templates list.
 * Each row links to its fill page ("Create Request") and carries a ⋮ menu — Edit, Pin/Unpin (the
 * pin controls whether it shows in the sidebar), Delete (confirmed). Authoring/pin/delete are
 * ChangePolicy-gated server-side; a non-author gets the backend's 403 as a toast.
 */
import {
    Bookmark,
    CircleHelp,
    EllipsisVertical,
    Pencil,
    Pin,
    PinOff,
    Plus,
    Trash2,
} from "lucide-react";
import { useRouter } from "next/navigation";
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
import { Tooltip } from "@/components/tooltip";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { apiErrorMessage } from "@/features/proposal-templates/api";
import { useCustomTemplatesAccess } from "@/features/proposal-templates/hooks/use-custom-templates-access";
import {
    useDeleteProposalTemplate,
    useUpdateProposalTemplate,
} from "@/features/proposal-templates/hooks/use-proposal-template-mutations";
import { useProposalTemplates } from "@/features/proposal-templates/hooks/use-proposal-templates";
import { manifestIdOf } from "@/features/proposal-templates/manifest";
import type { ProposalTemplate } from "@/features/proposal-templates/types";
import { useTreasury } from "@/hooks/use-treasury";

// Predicted official docs path; swap for the maintainers' docs-site URL once it exists.
const HOW_IT_WORKS_URL =
    "https://github.com/NEAR-DevHub/trezu/blob/main/docs/CUSTOM_PROPOSAL_TEMPLATES.md";

// The bare shadcn dropdown item is px-2 py-1.5 with no icon gap; the design wants 10×12 padding and
// a 12px icon-to-label gap, so the ⋮ menu items share this. Delete is a plain item (not red).
const MENU_ITEM_CLASS = "gap-3 px-3 py-2.5";

function HowItWorksLink() {
    const t = useTranslations("customTemplates");
    return (
        // Outline + default size so it reads as a real button and matches the height of the primary
        // it sits beside (the empty-state "Create Template" and the list-header "Add New").
        <Button variant="outline" asChild>
            <a href={HOW_IT_WORKS_URL} target="_blank" rel="noreferrer">
                <CircleHelp className="size-4" /> {t("howItWorks")}
            </a>
        </Button>
    );
}

/**
 * A primary action that, when the user lacks the required permission, renders disabled with a
 * tooltip explaining why — per review feedback we show + explain rather than hide, so a member sees
 * the action exists and understands they'd need a role for it (not that it's broken/taken away).
 */
function GatedButton({
    allowed,
    tooltip,
    children,
    ...buttonProps
}: {
    allowed: boolean;
    tooltip: string;
} & React.ComponentProps<typeof Button>) {
    if (allowed) {
        return <Button {...buttonProps}>{children}</Button>;
    }
    return (
        <Tooltip content={tooltip}>
            {/* Radix needs a real event target to hover; a disabled <button> emits none, so wrap it. */}
            <span className="inline-block">
                <Button {...buttonProps} disabled>
                    {children}
                </Button>
            </span>
        </Tooltip>
    );
}

function EmptyState({
    onCreate,
    canManage,
}: {
    onCreate: () => void;
    canManage: boolean;
}) {
    const t = useTranslations("customTemplates");
    const tAuth = useTranslations("auth");
    return (
        <PageCard className="items-center gap-3 py-16 text-center">
            <div className="flex size-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                <Bookmark className="size-5" />
            </div>
            <div className="flex flex-col gap-1">
                <h2 className="font-semibold text-base">
                    {t("index.emptyTitle")}
                </h2>
                <p className="max-w-sm text-muted-foreground text-sm">
                    {t("index.emptyDescription")}
                </p>
            </div>
            <div className="flex items-center gap-2">
                <HowItWorksLink />
                <GatedButton
                    allowed={canManage}
                    tooltip={tAuth("noPermission")}
                    onClick={onCreate}
                >
                    <Plus className="size-4" /> {t("index.createTemplate")}
                </GatedButton>
            </div>
        </PageCard>
    );
}

interface TemplateRowProps {
    template: ProposalTemplate;
    canManage: boolean;
    canPropose: boolean;
    onCreateRequest: () => void;
    onEdit: () => void;
    onTogglePin: () => void;
    onDelete: () => void;
}

function TemplateRow({
    template,
    canManage,
    canPropose,
    onCreateRequest,
    onEdit,
    onTogglePin,
    onDelete,
}: TemplateRowProps) {
    const t = useTranslations("customTemplates");
    const tCreate = useTranslations("createRequestButton");
    return (
        <div className="group flex min-h-[75px] items-center justify-between gap-3 rounded-xl bg-[#FAFAF9] p-4 dark:bg-muted">
            <div className="flex min-w-0 flex-col gap-0.5">
                <span className="truncate font-semibold text-[15px] text-foreground">
                    {template.name}
                </span>
                {template.description ? (
                    <span className="truncate text-[12px] text-muted-foreground">
                        {template.description}
                    </span>
                ) : null}
            </div>
            <div className="flex shrink-0 items-center gap-1">
                {/* Edit/Pin/Delete are authoring actions — managers only. Proposers just file. */}
                {canManage ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="icon-sm"
                                aria-label={t("index.actions")}
                                className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100"
                            >
                                <EllipsisVertical className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem
                                onClick={onEdit}
                                className={MENU_ITEM_CLASS}
                            >
                                <Pencil className="size-4" /> {t("index.edit")}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={onTogglePin}
                                className={MENU_ITEM_CLASS}
                            >
                                {template.pinned ? (
                                    <>
                                        <PinOff className="size-4" />{" "}
                                        {t("index.unpin")}
                                    </>
                                ) : (
                                    <>
                                        <Pin className="size-4" />{" "}
                                        {t("index.pin")}
                                    </>
                                )}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                                onClick={onDelete}
                                className={MENU_ITEM_CLASS}
                            >
                                <Trash2 className="size-4" />{" "}
                                {t("index.delete")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
                {/* Filing needs call:AddProposal (templates build a FunctionCall). Disable rather than
                    hide so a manager-only / transfer-only member sees the action and why it's blocked
                    instead of being walked into a dead-end fill form. */}
                <GatedButton
                    allowed={canPropose}
                    tooltip={tCreate("noPermission")}
                    onClick={onCreateRequest}
                >
                    {t("index.createRequest")}
                </GatedButton>
            </div>
        </div>
    );
}

export default function CustomTemplatesIndexPage() {
    const t = useTranslations("customTemplates");
    const tAuth = useTranslations("auth");
    const router = useRouter();
    const { treasuryId } = useTreasury();
    const { canManage, canPropose } = useCustomTemplatesAccess();
    const { data: templates, isLoading } = useProposalTemplates();
    const updateTemplate = useUpdateProposalTemplate();
    const deleteTemplate = useDeleteProposalTemplate();
    const [confirmingDelete, setConfirmingDelete] =
        useState<ProposalTemplate | null>(null);

    const enabled = (templates ?? []).filter(
        (template) => template.enabled && manifestIdOf(template.manifest),
    );

    const go = (suffix: string) =>
        router.push(`/${treasuryId}/custom-templates${suffix}`);

    function togglePin(template: ProposalTemplate) {
        updateTemplate.mutate(
            { id: template.id, input: { pinned: !template.pinned } },
            {
                onError: (error) =>
                    toast.error(apiErrorMessage(error, t("index.errPin"))),
            },
        );
    }

    async function handleDelete() {
        const template = confirmingDelete;
        if (!template) {
            return;
        }
        setConfirmingDelete(null);
        try {
            await deleteTemplate.mutateAsync(template.id);
            toast.success(t("toastDeleted"));
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
                ) : enabled.length === 0 ? (
                    <EmptyState
                        onCreate={() => go("/create")}
                        canManage={canManage}
                    />
                ) : (
                    <PageCard className="gap-4 p-5">
                        <div className="flex items-center justify-between gap-2">
                            <h2 className="font-semibold text-base">
                                {t("index.heading")}
                            </h2>
                            <div className="flex items-center gap-2">
                                <HowItWorksLink />
                                <GatedButton
                                    allowed={canManage}
                                    tooltip={tAuth("noPermission")}
                                    variant="secondary"
                                    onClick={() => go("/create")}
                                >
                                    <Plus className="size-4" />{" "}
                                    {t("index.addNew")}
                                </GatedButton>
                            </div>
                        </div>
                        <div className="flex flex-col gap-3">
                            {enabled.map((template) => (
                                <TemplateRow
                                    key={template.id}
                                    template={template}
                                    canManage={canManage}
                                    canPropose={canPropose}
                                    onCreateRequest={() =>
                                        go(
                                            `/${manifestIdOf(template.manifest)}`,
                                        )
                                    }
                                    onEdit={() =>
                                        go(
                                            `/${manifestIdOf(template.manifest)}/edit`,
                                        )
                                    }
                                    onTogglePin={() => togglePin(template)}
                                    onDelete={() =>
                                        setConfirmingDelete(template)
                                    }
                                />
                            ))}
                        </div>
                    </PageCard>
                )}
            </div>

            <Dialog
                open={confirmingDelete !== null}
                onOpenChange={(open) => !open && setConfirmingDelete(null)}
            >
                <DialogContent className="max-w-md gap-4">
                    <DialogHeader>
                        <DialogTitle>{t("deleteDialog.title")}</DialogTitle>
                    </DialogHeader>
                    <DialogDescription>
                        {t.rich("deleteDialog.body", {
                            name: confirmingDelete?.name ?? "",
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
