"use client";

import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/button";
import { PageCard } from "@/components/card";
import { ConnectWalletSelector } from "@/components/connect-wallet-selector";
import Logo from "@/components/icons/logo";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import { PageComponentLayout } from "@/components/page-component-layout";
import { StepperHeader } from "@/components/step-wizard";
import { Skeleton } from "@/components/ui/skeleton";
import { User } from "@/components/user";
import { useJoinViaInvite, useMemberInvite } from "@/hooks/use-member-invites";
import { useProfile } from "@/hooks/use-treasury-queries";
import { reportError } from "@/lib/report-error";
import { useNear } from "@/stores/near-store";

export default function JoinInvitePage() {
    const t = useTranslations("members.join");
    const params = useParams<{ token: string }>();
    const token = params.token;
    const router = useRouter();
    const { accountId, isInitializing, isAuthenticating, connect } = useNear();
    const { data: invite, isLoading, isError } = useMemberInvite(token);
    const joinMutation = useJoinViaInvite();
    const { data: profile, isLoading: isProfileLoading } =
        useProfile(accountId);

    const existingName = profile?.name?.trim() || "";
    const hasExistingName = existingName.length > 0;

    const [displayName, setDisplayName] = useState("");
    const [submitted, setSubmitted] = useState(false);
    const [joinedDaoId, setJoinedDaoId] = useState<string | null>(null);

    useEffect(() => {
        if (hasExistingName) {
            setDisplayName(existingName);
        }
    }, [existingName, hasExistingName]);

    const handleAskJoin = async () => {
        if (!token) return;
        try {
            const result = await joinMutation.mutateAsync({
                token,
                // Persist NEAR Social / local profile names onto user_profiles
                // so join-request lists show the same name.
                displayName: hasExistingName ? existingName : displayName,
            });
            setJoinedDaoId(result.daoId);
            setSubmitted(true);
        } catch (err: unknown) {
            reportError(err, "Failed to join via invite");
            const message =
                (err as { response?: { data?: string } })?.response?.data ||
                t("joinFailed");
            toast.error(
                typeof message === "string" ? message : t("joinFailed"),
            );
        }
    };

    const treasuryName = invite?.treasuryName || t("treasuryFallback");
    const showLogin = !accountId && invite?.status === "valid" && !submitted;
    // Keep ask / success / used / expired / invalid cards the same footprint.
    const formCardClassName = "gap-4 min-h-[340px]";

    return (
        <PageComponentLayout
            title={t("pageTitle")}
            description={t("pageDescription")}
            hideCollapseButton
            hideLogin={!accountId}
            logo={
                <Link href="/">
                    <Logo size="sm" />
                </Link>
            }
        >
            <div
                className={
                    showLogin
                        ? "mx-auto max-w-[668px] w-full md:mt-8"
                        : "max-w-xl mx-auto w-full"
                }
            >
                {isLoading || isInitializing ? (
                    <PageCard className={formCardClassName}>
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-4 w-72" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-10 w-full mt-auto" />
                    </PageCard>
                ) : isError || !invite ? (
                    <PageCard className={`${formCardClassName} justify-center`}>
                        <div className="flex w-full flex-col items-center text-center gap-4">
                            <div className="space-y-1">
                                <p className="font-semibold text-sm md:text-base">
                                    {t("invalidTitle")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {t("invalidDescription")}
                                </p>
                            </div>
                            <Button asChild className="w-full">
                                <Link href="/">{t("goHome")}</Link>
                            </Button>
                        </div>
                    </PageCard>
                ) : invite.status !== "valid" ? (
                    <PageCard className={`${formCardClassName} justify-center`}>
                        <div className="flex w-full flex-col items-center text-center gap-4">
                            <div className="space-y-1">
                                <p className="font-semibold text-sm md:text-base">
                                    {invite.status === "used"
                                        ? t("usedTitle")
                                        : t("expiredTitle")}
                                </p>
                                <p className="text-sm text-muted-foreground">
                                    {invite.status === "used"
                                        ? t("usedDescription")
                                        : t("expiredDescription")}
                                </p>
                            </div>
                            <Button asChild className="w-full">
                                <Link href="/">{t("goHome")}</Link>
                            </Button>
                        </div>
                    </PageCard>
                ) : submitted && joinedDaoId ? (
                    <PageCard className={`${formCardClassName} justify-center`}>
                        <div className="flex w-full flex-col items-center text-center gap-4">
                            <div className="flex size-12 items-center justify-center rounded-full bg-emerald-500/15">
                                <CheckCircle2 className="size-6 text-emerald-600" />
                            </div>
                            <div className="space-y-1">
                                <h2 className="text-xl font-semibold">
                                    {t("successTitle")}
                                </h2>
                                <p className="text-sm text-muted-foreground whitespace-pre-line max-w-[280px] mx-auto">
                                    {t("successDescription")}
                                </p>
                            </div>
                            <Button
                                className="w-full"
                                variant="secondary"
                                onClick={() => router.push(`/${joinedDaoId}`)}
                            >
                                {t("seeTreasury")}
                            </Button>
                        </div>
                    </PageCard>
                ) : !accountId ? (
                    <ConnectWalletSelector
                        source={`/join/${token}`}
                        connectFlow="within_treasury"
                        isConnectingWallet={isAuthenticating}
                        showCreateTreasuryCta={false}
                        showBackButton={false}
                        onConnectSupported={connect}
                        introTitle={t("connectTitle", {
                            treasury: treasuryName,
                        })}
                        introDescription={t("connectDescription")}
                    />
                ) : (
                    <PageCard className={formCardClassName}>
                        <StepperHeader
                            title={t("askTitle", {
                                treasury: treasuryName,
                            })}
                            description={t("askDescription")}
                        />

                        <InputBlock
                            title={t("walletConnected")}
                            invalid={false}
                            className="bg-transparent border-2"
                        >
                            <div className="pt-1">
                                <User
                                    accountId={accountId}
                                    size="md"
                                    withLink={false}
                                />
                            </div>
                        </InputBlock>

                        {isProfileLoading ? (
                            <Skeleton className="h-16 w-full" />
                        ) : (
                            <InputBlock
                                title={t("nameLabel")}
                                invalid={false}
                                interactive={!hasExistingName}
                                disabled={hasExistingName}
                            >
                                <LargeInput
                                    id="display-name"
                                    borderless
                                    value={
                                        hasExistingName
                                            ? existingName
                                            : displayName
                                    }
                                    onChange={(e) =>
                                        setDisplayName(e.target.value)
                                    }
                                    placeholder={t("namePlaceholder")}
                                    disabled={hasExistingName}
                                    readOnly={hasExistingName}
                                />
                            </InputBlock>
                        )}

                        <Button
                            className="w-full"
                            onClick={() => void handleAskJoin()}
                            disabled={
                                joinMutation.isPending || isProfileLoading
                            }
                        >
                            {joinMutation.isPending
                                ? t("submitting")
                                : t("askJoin")}
                        </Button>
                    </PageCard>
                )}
            </div>
        </PageComponentLayout>
    );
}
