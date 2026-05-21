import { ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/button";
import { PageComponentLayout } from "@/components/page-component-layout";
import { CardDescription, CardTitle } from "@/components/ui/card";
import { PageCard } from "@/components/card";

type EarnAppId = "rhea" | "intear" | "nearStaking";

const earnAppConfigs: {
    id: EarnAppId;
    goToHref: string;
    howItWorksHref?: string;
}[] = [
    {
        id: "rhea",
        goToHref: "https://x.rhea.finance/en/earn",
        howItWorksHref: "https://www.youtube.com/watch?v=gcXBmtbsw34",
    },
    {
        id: "intear",
        goToHref: "https://dex.intea.rs/",
        howItWorksHref: "https://www.youtube.com/watch?v=BClz1n642Y0",
    },
    {
        id: "nearStaking",
        goToHref: "https://near-staking.trezu.org/",
        howItWorksHref:
            "https://youtube.com/shorts/kwIWddeMXRM?si=wxe2qrS3fkHxLJPN",
    },
];

const earnAppMedia: Record<
    EarnAppId,
    { src: string; className: string; width?: number; height?: number }
> = {
    rhea: {
        src: "/icons/rhea.svg",
        className: "h-5 w-auto",
        width: 20,
        height: 20,
    },
    intear: {
        src: "/icons/intear.svg",
        className: "h-5 w-5",
        width: 20,
        height: 20,
    },
    nearStaking: {
        src: "https://near.com/static/icons/network/near.svg",
        className: "h-5 w-5",
        width: 20,
        height: 20,
    },
};

export default async function EarnPage() {
    const t = await getTranslations("pages.earn");

    return (
        <PageComponentLayout title={t("title")} description={t("description")}>
            <div className="mx-auto w-full max-w-5xl space-y-5">
                {earnAppConfigs.map((app) => {
                    const media = earnAppMedia[app.id];
                    return (
                        <PageCard key={app.id} className="p-5">
                            <div className="flex items-start gap-4">
                                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-black text-sm font-semibold text-white">
                                    <img
                                        src={media.src}
                                        alt={t(`apps.${app.id}.logoAlt`)}
                                        width={media.width}
                                        height={media.height}
                                        className={media.className}
                                    />
                                </div>
                                <div className="min-w-0 flex-1 space-y-4">
                                    <div>
                                        <CardTitle className="text-md">
                                            {t(`apps.${app.id}.name`)}
                                        </CardTitle>
                                        <CardDescription>
                                            {t(`apps.${app.id}.description`)}
                                        </CardDescription>
                                    </div>
                                    <div className="flex flex-wrap items-center gap-2.5">
                                        <Button asChild>
                                            <Link
                                                href={app.goToHref}
                                                target="_blank"
                                                rel="noreferrer noopener"
                                            >
                                                {t(`apps.${app.id}.goTo`)}
                                                <ArrowUpRight className="size-4" />
                                            </Link>
                                        </Button>
                                        {app.howItWorksHref ? (
                                            <Button variant="outline" asChild>
                                                <Link
                                                    href={app.howItWorksHref}
                                                    target="_blank"
                                                    rel="noreferrer noopener"
                                                >
                                                    {t("howItWorks")}
                                                    <ArrowUpRight className="size-4" />
                                                </Link>
                                            </Button>
                                        ) : null}
                                    </div>
                                </div>
                            </div>
                        </PageCard>
                    );
                })}
            </div>
        </PageComponentLayout>
    );
}
