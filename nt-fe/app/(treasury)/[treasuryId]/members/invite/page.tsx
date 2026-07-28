"use client";

import { Check, Info, Link, RefreshCw, UserPlus, Vote } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { CopyButton } from "@/components/copy-button";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepperHeader } from "@/components/step-wizard";
import { useCreateMemberInvite } from "@/hooks/use-member-invites";
import { useTreasury } from "@/hooks/use-treasury";
import { useMemberPolicyGate } from "../hooks/use-member-policy-gate";

export default function InviteMemberPage() {
    const t = useTranslations("pages.members");
    const tInvite = useTranslations("members.invite");
    const { treasuryId } = useTreasury();
    const router = useRouter();
    const { isLoadingPolicy, canAddMember } = useMemberPolicyGate(treasuryId);
    const createInvite = useCreateMemberInvite(treasuryId);

    const [step, setStep] = useState(0);
    const [inviteUrl, setInviteUrl] = useState<string | null>(null);

    // Invite links do not create a ChangePolicy proposal, so they stay available
    // while a policy change is pending. Only permission gates this page.
    useEffect(() => {
        if (!isLoadingPolicy && !canAddMember && treasuryId) {
            router.replace(`/${treasuryId}/members`);
        }
    }, [isLoadingPolicy, canAddMember, router, treasuryId]);

    const exitToMembers = useCallback(() => {
        router.push(`/${treasuryId}/members`);
    }, [router, treasuryId]);

    const handleGenerate = useCallback(async () => {
        try {
            const result = await createInvite.mutateAsync();
            setInviteUrl(result.url);
            setStep(1);
        } catch (error) {
            console.error("Failed to create invite:", error);
            toast.error(tInvite("generateFailed"));
        }
    }, [createInvite, tInvite]);

    const howItWorks = [
        {
            icon: Link,
            title: tInvite("howItWorks.generateTitle"),
            description: tInvite("howItWorks.generateDescription"),
        },
        {
            icon: UserPlus,
            title: tInvite("howItWorks.joinTitle"),
            description: tInvite("howItWorks.joinDescription"),
        },
        {
            icon: Vote,
            title: tInvite("howItWorks.voteTitle"),
            description: tInvite("howItWorks.voteDescription"),
        },
    ];

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <div className="max-w-xl mx-auto w-full">
                <PageCard>
                    <StepperHeader
                        title={tInvite("title")}
                        handleBack={
                            step === 0 ? exitToMembers : () => setStep(0)
                        }
                    />
                    {step === 0 ? (
                        <>
                            <div className="space-y-4">
                                <p className="text-sm text-muted-foreground">
                                    {tInvite("howItWorks.title")}
                                </p>
                                <div className="space-y-6">
                                    {howItWorks.map((item) => {
                                        const Icon = item.icon;
                                        return (
                                            <div
                                                key={item.title}
                                                className="flex items-start gap-4"
                                            >
                                                <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted">
                                                    <Icon className="size-4 text-base" />
                                                </div>
                                                <div className="space-y-0.5">
                                                    <p className="text-sm font-medium">
                                                        {item.title}
                                                    </p>
                                                    <p className="text-xs text-muted-foreground">
                                                        {item.description}
                                                    </p>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>
                            <Button
                                type="button"
                                className="w-full mt-3"
                                onClick={() => void handleGenerate()}
                                disabled={createInvite.isPending}
                            >
                                {createInvite.isPending
                                    ? tInvite("generating")
                                    : tInvite("generateLink")}
                            </Button>
                        </>
                    ) : (
                        <>
                            <div className="space-y-6">
                                <div className="flex items-start gap-3">
                                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-emerald-500/15">
                                        <Check className="size-4 text-emerald-600" />
                                    </div>
                                    <div className="space-y-0.5">
                                        <p className="text-sm font-medium">
                                            {tInvite("readyTitle")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {tInvite("readyDescription")}
                                        </p>
                                    </div>
                                </div>
                                <div className="flex items-start gap-3">
                                    <div className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sky-500/15">
                                        <Info className="size-4 text-sky-600" />
                                    </div>
                                    <div className="space-y-0.5">
                                        <p className="text-sm font-medium">
                                            {tInvite("onceTitle")}
                                        </p>
                                        <p className="text-xs text-muted-foreground">
                                            {tInvite("onceDescription")}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            <div className="space-y-2">
                                <p className="text-sm text-muted-foreground">
                                    {tInvite("yourLink")}
                                </p>
                                <div className="flex items-center gap-2 rounded-lg bg-secondary p-2 pl-3">
                                    <Link className="size-4 shrink-0 text-base" />
                                    <span className="flex-1 truncate text-sm font-medium">
                                        {inviteUrl}
                                    </span>
                                    <CopyButton
                                        text={inviteUrl || ""}
                                        toastMessage={tInvite("linkCopied")}
                                        size="default"
                                    >
                                        {tInvite("copyLink")}
                                    </CopyButton>
                                </div>
                            </div>

                            <Button
                                type="button"
                                variant="ghost"
                                className="w-full"
                                onClick={() => void handleGenerate()}
                                disabled={createInvite.isPending}
                            >
                                <RefreshCw className="size-4" />
                                {tInvite("generateNewLink")}
                            </Button>
                        </>
                    )}
                </PageCard>
            </div>
        </PageComponentLayout>
    );
}
