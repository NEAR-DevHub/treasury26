"use client";

import { ChevronDown } from "lucide-react";
import { CirclePlay } from "lucide-react";
import { useState } from "react";
import { useTranslations } from "next-intl";
import { PageCard } from "@/components/card";

export function DepositFaq() {
    const t = useTranslations("depositModal");
    const [openIndex, setOpenIndex] = useState<number | null>(null);
    const faqItems = [
        // UNCOMMENT AFTER VIDEOS ARE UPLOADED
        // {
        //     question: t("faq.publicWalletQuestion"),
        //     videoUrl: "/",
        // },
        // {
        //     question: t("faq.confidentialWalletQuestion"),
        //     videoUrl: "/",
        // },
        {
            question: t("faq.fiatQuestion"),
            answer: t("faq.fiatAnswer"),
        },
        {
            question: t("faq.arrivalQuestion"),
            answer: t("faq.arrivalAnswer"),
        },
    ];

    return (
        <PageCard className="gap-0 w-full bg-general-tertiary">
            <p className="font-semibold">{t("faq.title")}</p>
            <div className="divide-y divide-border">
                {faqItems.map((item, index) => {
                    const isOpen = openIndex === index;

                    // if (item.videoUrl) {
                    //     return (
                    //         <a
                    //             key={item.question}
                    //             href={item.videoUrl}
                    //             target="_blank"
                    //             rel="noopener noreferrer"
                    //             className="w-full py-3 block"
                    //         >
                    //             <div className="flex items-start justify-between gap-3">
                    //                 <span className="text-sm font-medium">
                    //                     {item.question}
                    //                 </span>
                    //                 <CirclePlay className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" />
                    //             </div>
                    //         </a>
                    //     );
                    // }

                    return (
                        <button
                            key={item.question}
                            type="button"
                            onClick={() => setOpenIndex(isOpen ? null : index)}
                            className="w-full py-3 text-left"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <span className="text-sm font-medium">
                                    {item.question}
                                </span>
                                <ChevronDown
                                    className={`mt-0.5 h-4 w-4 shrink-0 transition-transform ${
                                        isOpen ? "rotate-180" : ""
                                    }`}
                                />
                            </div>
                            {isOpen && (
                                <p className="mt-2 text-sm text-muted-foreground">
                                    {item.answer}
                                </p>
                            )}
                        </button>
                    );
                })}
            </div>
        </PageCard>
    );
}
