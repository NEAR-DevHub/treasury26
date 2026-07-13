"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { trackEvent } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CreateRequestButton } from "@/components/create-request-button";
import { Input } from "@/components/input";
import { TreasuryLogo } from "@/components/treasury-info";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { useTreasury } from "@/hooks/use-treasury";
import {
    useTreasuryConfig,
    useTreasuryPolicy,
} from "@/hooks/use-treasury-queries";
import { encodeToMarkdown, jsonToBase64 } from "@/lib/utils";
import { useNear } from "@/stores/near-store";

const COLOR_OPTIONS = [
    "#000000", // black (appears as white in dark mode)
    "#6B7280", // gray
    "#EF4444", // red
    "#F97316", // orange
    "#F59E0B", // amber
    "#EAB308", // yellow
    "#84CC16", // lime
    "#22C55E", // green
    "#14B8A6", // teal
    "#06B6D4", // cyan
    "#0EA5E9", // sky
    "#0953FF", // blue
    "#6366F1", // indigo
    "#8B5CF6", // violet
    "#A855F7", // purple
    "#D946EF", // fuchsia
    "#EC4899", // pink
    "#F43F5E", // rose
];

type GeneralFormValues = {
    displayName: string;
    accountName: string;
    primaryColor: string;
    logo: string | null;
};

export function GeneralTab() {
    const t = useTranslations("settings.general");
    const generalSchema = useMemo(
        () =>
            z.object({
                displayName: z
                    .string()
                    .min(1, t("validation.displayNameRequired"))
                    .max(100, t("validation.displayNameMax")),
                accountName: z.string(),
                primaryColor: z.string(),
                logo: z.string().nullable(),
            }),
        [t],
    );
    const { treasuryId, config } = useTreasury();
    const { createProposal } = useNear();
    const { data: policy } = useTreasuryPolicy(treasuryId);
    const queryClient = useQueryClient();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadingImage, setUploadingImage] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const form = useForm<GeneralFormValues>({
        resolver: zodResolver(generalSchema),
        defaultValues: {
            displayName: "",
            accountName: "",
            primaryColor: "",
            logo: null,
        },
    });

    // Update form when treasury data loads
    useEffect(() => {
        if (config) {
            const treasuryData = {
                displayName: config?.name || "",
                accountName: treasuryId || "",
                // Keep empty when unset so we don't invent a color in the proposal payload
                primaryColor: config.metadata?.primaryColor || "",
                logo: config.metadata?.flagLogo || null,
            };
            form.reset(treasuryData);
        }
    }, [config, treasuryId, form]);

    const onSubmit = async (data: GeneralFormValues) => {
        if (!treasuryId || !config) {
            toast.error(t("treasuryNotFound"));
            return;
        }

        setIsSubmitting(true);
        try {
            const proposalBond = policy?.proposal_bond || "0";

            // ChangeConfig replaces the entire metadata blob. Preserve the
            // on-chain primaryColor unless the user actually picked a new one,
            // and never invent a default color for logo-only updates.
            const metadata: Record<string, string | null> = {
                flagLogo: data.logo,
            };

            const existingColor = config.metadata?.primaryColor;
            if (data.primaryColor && data.primaryColor !== existingColor) {
                metadata.primaryColor = data.primaryColor;
            } else if (existingColor) {
                metadata.primaryColor = existingColor;
            }

            const description = {
                title: t("proposalDescriptionTitle"),
            };

            await createProposal(t("proposalSubmitted"), {
                treasuryId: treasuryId,
                proposal: {
                    description: encodeToMarkdown(description),
                    kind: {
                        ChangeConfig: {
                            config: {
                                name: data.displayName,
                                purpose: config.purpose,
                                metadata: jsonToBase64(metadata),
                            },
                        },
                    },
                },
                proposalBond: proposalBond,
                proposalType: "other",
            });

            // Refetch proposals to show the newly created proposal
            queryClient.invalidateQueries({
                queryKey: ["proposals", treasuryId],
            });

            // Reset form to mark as not dirty
            form.reset(data);
            trackEvent("treasury-settings-updated", {
                treasury_id: treasuryId ?? "",
            });
        } catch (error) {
            console.error("Error creating proposal:", error);
        } finally {
            setIsSubmitting(false);
        }
    };

    const handleColorChange = (color: string) => {
        form.setValue("primaryColor", color, { shouldDirty: true });
    };

    const uploadImageToServer = async (file: File) => {
        setUploadingImage(true);

        try {
            const response = await fetch("https://ipfs.near.social/add", {
                method: "POST",
                headers: { Accept: "application/json" },
                body: file,
            });

            const result = await response.json();
            if (result.cid) {
                const imageUrl = `https://ipfs.near.social/ipfs/${result.cid}`;
                form.setValue("logo", imageUrl, { shouldDirty: true });
                toast.success(t("logoUploaded"));
            } else {
                toast.error(t("uploadError"));
            }
        } catch (error) {
            console.error("Upload error:", error);
            toast.error(t("uploadError"));
        } finally {
            setUploadingImage(false);
        }
    };

    const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        const reader = new FileReader();

        reader.onload = () => {
            const img = new Image();
            img.src = reader.result as string;

            img.onload = () => {
                // Check dimensions
                if (img.width === 256 && img.height === 256) {
                    uploadImageToServer(file);
                } else {
                    toast.error(t("invalidLogo"));
                }
            };

            img.onerror = () => {
                toast.error(t("invalidImage"));
            };
        };

        reader.onerror = () => {
            console.error("Error reading file");
            toast.error(t("fileReadError"));
        };

        reader.readAsDataURL(file);

        // Reset the input value so the same file can be selected again
        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    const handleUploadClick = () => {
        fileInputRef.current?.click();
    };

    return (
        <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                <PageCard>
                    <div>
                        <h3 className="text-lg font-semibold">
                            {t("treasuryName")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("treasuryNameDescription")}
                        </p>
                    </div>

                    <div className="space-y-4">
                        <FormField
                            control={form.control}
                            name="displayName"
                            render={({ field }) => (
                                <FormItem>
                                    <div className="space-y-2">
                                        <Label htmlFor="display-name">
                                            {t("displayName")}
                                        </Label>
                                        <FormControl>
                                            <Input
                                                id="display-name"
                                                clearable={false}
                                                {...field}
                                                placeholder={t(
                                                    "displayNamePlaceholder",
                                                )}
                                            />
                                        </FormControl>
                                        {form.formState.errors.displayName && (
                                            <p className="text-sm text-destructive">
                                                {
                                                    form.formState.errors
                                                        .displayName.message
                                                }
                                            </p>
                                        )}
                                    </div>
                                </FormItem>
                            )}
                        />

                        <FormField
                            control={form.control}
                            name="accountName"
                            render={({ field }) => (
                                <FormItem>
                                    <div className="space-y-2">
                                        <Label htmlFor="account-name">
                                            {t("accountName")}
                                        </Label>
                                        <FormControl>
                                            <Input
                                                id="account-name"
                                                clearable={false}
                                                {...field}
                                                disabled={true}
                                            />
                                        </FormControl>
                                    </div>
                                </FormItem>
                            )}
                        />
                    </div>
                </PageCard>

                <PageCard>
                    <div>
                        <h3 className="text-lg font-semibold">{t("logo")}</h3>
                        <p className="text-sm text-muted-foreground">
                            {t("logoDescription")}
                        </p>
                    </div>
                    <FormField
                        control={form.control}
                        name="logo"
                        render={({ field }) => (
                            <FormItem>
                                <div className="flex items-center gap-4">
                                    <div className="flex h-16 w-16 items-center justify-center rounded-lg">
                                        <TreasuryLogo
                                            logo={field.value}
                                            alt={t("treasuryLogoAlt")}
                                            imageClassName="h-full w-full rounded-lg"
                                            fallbackClassName="bg-muted rounded-full size-auto p-2.5"
                                            fallbackIconClassName="h-8 w-8 shrink-0 text-muted-foreground"
                                        />
                                    </div>
                                    <input
                                        ref={fileInputRef}
                                        type="file"
                                        accept="image/png, image/jpeg, image/svg+xml"
                                        onChange={handleImageChange}
                                        className="hidden"
                                    />
                                    <div className="flex gap-2">
                                        <Button
                                            type="button"
                                            variant="outline"
                                            onClick={handleUploadClick}
                                            disabled={uploadingImage}
                                        >
                                            {uploadingImage ? (
                                                <>
                                                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                    {t("uploading")}
                                                </>
                                            ) : (
                                                t("uploadLogo")
                                            )}
                                        </Button>
                                        {field.value && (
                                            <Button
                                                type="button"
                                                variant="link"
                                                onClick={() => {
                                                    field.onChange("");
                                                    form.setValue("logo", "", {
                                                        shouldDirty: true,
                                                    });
                                                }}
                                                disabled={uploadingImage}
                                            >
                                                {t("removeLogo")}
                                            </Button>
                                        )}
                                    </div>
                                </div>
                            </FormItem>
                        )}
                    />
                </PageCard>

                <PageCard>
                    <div>
                        <h3 className="text-lg font-semibold">
                            {t("primaryColor")}
                        </h3>
                        <p className="text-sm text-muted-foreground">
                            {t("primaryColorDescription")}
                        </p>
                    </div>

                    <FormField
                        control={form.control}
                        name="primaryColor"
                        render={({ field }) => (
                            <FormItem>
                                <div className="flex flex-wrap gap-2">
                                    {COLOR_OPTIONS.map((color) => (
                                        <button
                                            key={color}
                                            type="button"
                                            onClick={() =>
                                                handleColorChange(color)
                                            }
                                            className={`h-8 w-8 rounded-full transition-all hover:scale-110 cursor-pointer ${
                                                field.value === color
                                                    ? "ring-2 ring-offset-2 ring-offset-background ring-primary"
                                                    : ""
                                            } ${color === "#000000" ? "bg-black dark:bg-white" : ""}`}
                                            style={
                                                color === "#000000"
                                                    ? {}
                                                    : { backgroundColor: color }
                                            }
                                            aria-label={t("selectColorLabel", {
                                                color,
                                            })}
                                        />
                                    ))}
                                </div>
                            </FormItem>
                        )}
                    />
                </PageCard>

                <div className="rounded-lg border bg-card">
                    <CreateRequestButton
                        type="submit"
                        isSubmitting={isSubmitting}
                        permissions={{ kind: "config", action: "AddProposal" }}
                        disabled={!form.formState.isDirty}
                    />
                </div>
            </form>
        </Form>
    );
}
