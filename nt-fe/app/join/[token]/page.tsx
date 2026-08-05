"use client";

import { Check, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState } from "react";
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
import { useProfile, useUserTreasuries } from "@/hooks/use-treasury-queries";
import { reportError } from "@/lib/report-error";
import { useNear } from "@/stores/near-store";

const ALREADY_MEMBER_ERROR = "Account is already a treasury member";

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
    const { data: treasuries, isLoading: isTreasuriesLoading } =
        useUserTreasuries(accountId);

    const existingName = profile?.name?.trim() || "";
    const hasExistingName = existingName.length > 0;

    const [displayName, setDisplayName] = useState("");
    const [submitted, setSubmitted] = useState(false);
    const [joinedDaoId, setJoinedDaoId] = useState<string | null>(null);
    const [alreadyMemberFromJoin, setAlreadyMemberFromJoin] = useState(false);

    const viewerStatus = invite?.viewerStatus;
    const isAlreadyMember =
        alreadyMemberFromJoin ||
        viewerStatus === "member" ||
        Boolean(
            invite &&
                accountId &&
                treasuries?.some(
                    (treasury) =>
                        treasury.daoId === invite.daoId && treasury.isMember,
                ),
        );
    const hasPendingRequest =
        viewerStatus === "pending" || (submitted && !!joinedDaoId);
    const treasuryDaoId = invite?.daoId;
    const pendingDaoId =
        joinedDaoId || (viewerStatus === "pending" ? invite?.daoId : null);

    const handleAskJoin = async () => {
        if (!token) return;
        try {
            const result = await joinMutation.mutateAsync({
                token,
                // Only send a name when the user entered one; existing profile
                // names are already available via useProfile / User.
                ...(hasExistingName
                    ? {}
                    : { displayName: displayName.trim() || undefined }),
            });
            setJoinedDaoId(result.daoId);
            setSubmitted(true);
        } catch (err: unknown) {
            const message = (err as { response?: { data?: string } })?.response
                ?.data;
            if (
                typeof message === "string" &&
                message.includes(ALREADY_MEMBER_ERROR)
            ) {
                setAlreadyMemberFromJoin(true);
                return;
            }
            reportError(err, "Failed to join via invite");
            toast.error(
                typeof message === "string" ? message : t("joinFailed"),
            );
        }
    };

    const treasuryName = invite?.treasuryName || t("treasuryFallback");
    const showLogin =
        !accountId &&
        invite?.status === "valid" &&
        !hasPendingRequest &&
        !isAlreadyMember;
    // Keep ask / success / used / expired / invalid cards the same footprint.
    const formCardClassName = "gap-4 min-h-[340px]";

    const alreadyMemberCard = treasuryDaoId ? (
        <PageCard className={`${formCardClassName} justify-center`}>
            <div className="flex w-full flex-col items-center text-center gap-4">
                <div className="flex size-8 items-center justify-center rounded-full bg-emerald-500/15">
                    <Check className="size-4 text-emerald-600" />
                </div>
                <div className="space-y-1">
                    <h2 className="text-xl font-semibold">
                        {t("alreadyMemberTitle")}
                    </h2>
                    <p className="text-sm text-muted-foreground max-w-[280px] mx-auto">
                        {t("alreadyMemberDescription", {
                            treasury: treasuryName,
                        })}
                    </p>
                </div>
                <Button
                    className="w-full"
                    variant="secondary"
                    onClick={() => router.push(`/${treasuryDaoId}`)}
                >
                    {t("goToTreasury")}
                </Button>
            </div>
        </PageCard>
    ) : null;

    const pendingSuccessCard = pendingDaoId ? (
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
                    onClick={() => router.push(`/${pendingDaoId}`)}
                >
                    {t("seeTreasury")}
                </Button>
            </div>
        </PageCard>
    ) : null;

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
                ) : isAlreadyMember && alreadyMemberCard ? (
                    alreadyMemberCard
                ) : hasPendingRequest && pendingSuccessCard ? (
                    pendingSuccessCard
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
                ) : isTreasuriesLoading && viewerStatus == null ? (
                    <PageCard className={formCardClassName}>
                        <Skeleton className="h-6 w-48" />
                        <Skeleton className="h-4 w-72" />
                        <Skeleton className="h-24 w-full" />
                        <Skeleton className="h-10 w-full mt-auto" />
                    </PageCard>
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
