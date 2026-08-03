"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { Input } from "@/components/input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { Form, FormControl, FormField, FormItem } from "@/components/ui/form";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useProfile } from "@/hooks/use-treasury-queries";
import { updateProfile } from "@/lib/api";
import { resolveProfileImageUrl } from "@/lib/profile-image";
import { useNear } from "@/stores/near-store";

function AvatarFallback({
    displayName,
    accountId,
}: {
    displayName: string;
    accountId: string;
}) {
    // Prefer display-name initial; otherwise first char of wallet (same as User).
    const name = displayName.trim();
    const initial =
        name && name !== accountId
            ? name.charAt(0).toUpperCase()
            : accountId.charAt(0).toLowerCase() || "?";

    return (
        <div
            className="size-16 rounded-full flex items-center justify-center bg-accent text-accent-foreground text-lg font-medium"
            aria-hidden
        >
            {initial}
        </div>
    );
}

type AccountFormValues = {
    displayName: string;
    wallet: string;
    avatarUrl: string | null;
};

export default function AccountPage() {
    const t = useTranslations("account");
    const tPages = useTranslations("pages.account");
    const { accountId, isAuthenticated } = useNear();
    const { data: profile, isLoading: isLoadingProfile } =
        useProfile(accountId);
    const queryClient = useQueryClient();
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [uploadingImage, setUploadingImage] = useState(false);
    const [isSubmitting, setIsSubmitting] = useState(false);

    const schema = useMemo(
        () =>
            z.object({
                displayName: z.string().trim().min(1).max(100),
                wallet: z.string(),
                avatarUrl: z.string().nullable(),
            }),
        [],
    );

    const form = useForm<AccountFormValues>({
        resolver: zodResolver(schema),
        defaultValues: {
            displayName: "",
            wallet: accountId || "",
            avatarUrl: null,
        },
    });

    useEffect(() => {
        if (!accountId) return;
        form.reset({
            displayName: profile?.name || "",
            wallet: accountId,
            avatarUrl: resolveProfileImageUrl(profile?.image) ?? null,
        });
    }, [accountId, profile, form]);

    const avatarUrl = form.watch("avatarUrl");
    const displayName = form.watch("displayName");
    const trimmedDisplayName = displayName.trim();
    const canSave =
        form.formState.isDirty &&
        trimmedDisplayName.length > 0 &&
        trimmedDisplayName.length <= 100;

    const onSubmit = async (data: AccountFormValues) => {
        if (!accountId || !isAuthenticated) {
            toast.error(t("saveError"));
            return;
        }

        setIsSubmitting(true);
        try {
            const trimmedName = data.displayName.trim();
            await updateProfile({
                displayName: trimmedName,
                avatarUrl: data.avatarUrl,
            });
            await queryClient.invalidateQueries({ queryKey: ["profile"] });
            form.reset({
                displayName: trimmedName,
                wallet: accountId,
                avatarUrl: data.avatarUrl,
            });
            toast.success(t("saveSuccess"));
        } catch (error) {
            console.error("Failed to save profile:", error);
            toast.error(t("saveError"));
        } finally {
            setIsSubmitting(false);
        }
    };

    const uploadImageToIpfs = async (file: File) => {
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
                form.setValue("avatarUrl", imageUrl, { shouldDirty: true });
                toast.success(t("avatarUploaded"));
            } else {
                toast.error(t("uploadError"));
            }
        } catch (error) {
            console.error("Avatar upload error:", error);
            toast.error(t("uploadError"));
        } finally {
            setUploadingImage(false);
        }
    };

    const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            toast.error(t("invalidImage"));
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
            return;
        }

        void uploadImageToIpfs(file);

        if (fileInputRef.current) {
            fileInputRef.current.value = "";
        }
    };

    if (!accountId || !isAuthenticated) {
        return (
            <PageComponentLayout
                title={tPages("title")}
                description={tPages("description")}
            >
                <div className="w-full max-w-xl mx-auto">
                    <PageCard>
                        <p className="text-sm text-muted-foreground">
                            {t("signInRequired")}
                        </p>
                    </PageCard>
                </div>
            </PageComponentLayout>
        );
    }

    return (
        <PageComponentLayout
            title={tPages("title")}
            description={tPages("description")}
        >
            <div className="w-full max-w-xl mx-auto">
                {isLoadingProfile ? (
                    <PageCard className="space-y-6">
                        <Skeleton className="h-6 w-40" />
                        <div className="flex items-center gap-4">
                            <Skeleton className="size-16 rounded-full" />
                            <Skeleton className="h-9 w-32" />
                        </div>
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                        <Skeleton className="h-10 w-full" />
                    </PageCard>
                ) : (
                    <Form {...form}>
                        <form onSubmit={form.handleSubmit(onSubmit)}>
                            <PageCard>
                                <h3 className="text-lg font-semibold">
                                    {t("personalSettings")}
                                </h3>

                                <FormField
                                    control={form.control}
                                    name="avatarUrl"
                                    render={() => (
                                        <FormItem>
                                            <div className="flex items-center gap-3">
                                                <div className="size-16 shrink-0">
                                                    {avatarUrl ? (
                                                        <img
                                                            src={avatarUrl}
                                                            alt={
                                                                displayName ||
                                                                accountId
                                                            }
                                                            className="size-14 rounded-full object-cover border border-border"
                                                        />
                                                    ) : (
                                                        <AvatarFallback
                                                            displayName={
                                                                displayName
                                                            }
                                                            accountId={
                                                                accountId ?? ""
                                                            }
                                                        />
                                                    )}
                                                </div>
                                                <input
                                                    ref={fileInputRef}
                                                    type="file"
                                                    accept="image/png,image/jpeg,image/webp,image/gif"
                                                    onChange={handleImageChange}
                                                    className="hidden"
                                                />
                                                <div className="flex flex-wrap items-center gap-2">
                                                    <Button
                                                        type="button"
                                                        variant="outline"
                                                        onClick={() =>
                                                            fileInputRef.current?.click()
                                                        }
                                                        disabled={
                                                            uploadingImage ||
                                                            isSubmitting
                                                        }
                                                    >
                                                        {uploadingImage ? (
                                                            <>
                                                                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                                                {t("uploading")}
                                                            </>
                                                        ) : (
                                                            t("uploadAvatar")
                                                        )}
                                                    </Button>
                                                    {avatarUrl && (
                                                        <Button
                                                            type="button"
                                                            variant="link"
                                                            onClick={() =>
                                                                form.setValue(
                                                                    "avatarUrl",
                                                                    null,
                                                                    {
                                                                        shouldDirty: true,
                                                                    },
                                                                )
                                                            }
                                                            disabled={
                                                                uploadingImage ||
                                                                isSubmitting
                                                            }
                                                        >
                                                            {t("removeAvatar")}
                                                        </Button>
                                                    )}
                                                </div>
                                            </div>
                                        </FormItem>
                                    )}
                                />

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
                                                        maxLength={100}
                                                        {...field}
                                                        placeholder={t(
                                                            "displayNamePlaceholder",
                                                        )}
                                                    />
                                                </FormControl>
                                            </div>
                                        </FormItem>
                                    )}
                                />

                                <FormField
                                    control={form.control}
                                    name="wallet"
                                    render={({ field }) => (
                                        <FormItem>
                                            <div className="space-y-2">
                                                <Label htmlFor="my-wallet">
                                                    {t("myWallet")}
                                                </Label>
                                                <FormControl>
                                                    <Input
                                                        id="my-wallet"
                                                        clearable={false}
                                                        {...field}
                                                        disabled
                                                    />
                                                </FormControl>
                                            </div>
                                        </FormItem>
                                    )}
                                />

                                <Button
                                    type="submit"
                                    className="w-full"
                                    disabled={
                                        isSubmitting ||
                                        uploadingImage ||
                                        !canSave
                                    }
                                >
                                    {isSubmitting ? (
                                        <>
                                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                                            {t("saving")}
                                        </>
                                    ) : (
                                        t("saveChanges")
                                    )}
                                </Button>
                            </PageCard>
                        </form>
                    </Form>
                )}
            </div>
        </PageComponentLayout>
    );
}
