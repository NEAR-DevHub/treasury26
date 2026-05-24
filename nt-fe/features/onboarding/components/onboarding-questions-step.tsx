"use client";

import posthog from "posthog-js";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFormContext } from "react-hook-form";
import { useTranslations } from "next-intl";
import z from "zod";
import { type StepProps } from "@/components/step-wizard";
import { useChains } from "@/features/address-book/chains";
import { trackEvent } from "@/lib/analytics";
import { OnboardingQuestionnaireCard } from "./onboarding-questionnaire-card";
import { NEAR_NETWORK_ID } from "@/constants/network-ids";

const questionnaireAnswerSchema = z.object({
    selected: z.array(z.string()),
    other: z.string().max(280).optional(),
});

export const ONBOARDING_ABOUT_SCHEMA = z.object({
    useCases: questionnaireAnswerSchema,
    networks: questionnaireAnswerSchema,
    biggestChallenges: questionnaireAnswerSchema,
});

export type OnboardingAboutValues = z.infer<typeof ONBOARDING_ABOUT_SCHEMA>;

export const ONBOARDING_ABOUT_DEFAULT_VALUES: OnboardingAboutValues = {
    useCases: { selected: [], other: "" },
    networks: { selected: [], other: "" },
    biggestChallenges: { selected: [], other: "" },
};

interface QuestionnaireOption {
    id: string;
    label: string;
    iconSrc?: string;
    iconImageClassName?: string;
}

type QuestionnaireBaseFieldName =
    | "about.useCases"
    | "about.networks"
    | "about.biggestChallenges";

type QuestionnaireFieldName =
    | `${QuestionnaireBaseFieldName}.selected`
    | `${QuestionnaireBaseFieldName}.other`;

type QuestionnaireSelectionMode = "single" | "multiple";

interface QuestionnaireStep {
    title: string;
    question: string;
    fieldName: QuestionnaireBaseFieldName;
    options: QuestionnaireOption[];
    surveyLabelsById: Record<string, string>;
    selectionMode: QuestionnaireSelectionMode;
    placeholder?: string;
}

const USE_CASE_OPTION_IDS = [
    "team-payroll-grants",
    "company-assets-management",
    "dao-treasury-management",
    "investment-portfolio",
    "operational-spending",
    "other",
] as const;

const NETWORK_OPTION_IDS = [
    NEAR_NETWORK_ID,
    "bitcoin",
    "ethereum",
    "solana",
    "arbitrum",
    "base",
    "optimism",
    "polygon",
    "gnosis",
    "avalanche",
    "bnb-chain",
    "other",
] as const;

const BIGGEST_CHALLENGE_OPTION_IDS = [
    "slow-approvals-and-signing",
    "lack-of-transparency-in-the-team",
    "hard-to-track-spending-and-balances",
    "security-and-access-control",
    "no-good-web3-tool-yet",
    "looking-for-crypto-earnings",
    "other",
] as const;

const SURVEY_OTHER_LABEL = "Other";
const SURVEY_SKIP_LABEL = "Skip";

const SURVEY_ENGLISH_LABELS: Record<
    QuestionnaireBaseFieldName,
    Record<string, string>
> = {
    "about.useCases": {
        "team-payroll-grants": "Team payroll & grants",
        "company-assets-management": "Company assets management",
        "dao-treasury-management": "DAO treasury management",
        "investment-portfolio": "Investment portfolio",
        "operational-spending": "Operational spending",
        other: SURVEY_OTHER_LABEL,
    },
    "about.networks": {
        near: "NEAR",
        bitcoin: "Bitcoin",
        ethereum: "Ethereum",
        solana: "Solana",
        arbitrum: "Arbitrum",
        base: "Base",
        optimism: "Optimism",
        polygon: "Polygon",
        gnosis: "Gnosis",
        avalanche: "Avalanche",
        "bnb-chain": "BNB Chain",
        other: SURVEY_OTHER_LABEL,
    },
    "about.biggestChallenges": {
        "slow-approvals-and-signing": "Slow approvals and signing",
        "lack-of-transparency-in-the-team": "Lack of transparency in the team",
        "hard-to-track-spending-and-balances":
            "Hard to track spending and balances",
        "security-and-access-control": "Security and access control",
        "no-good-web3-tool-yet": "No good Web3 tool yet",
        "looking-for-crypto-earnings": "I am looking for crypto earnings",
        other: SURVEY_OTHER_LABEL,
    },
};

const NETWORK_OPTION_CHAIN_KEY: Record<string, string> = {
    [NEAR_NETWORK_ID]: NEAR_NETWORK_ID,
    bitcoin: "bitcoin",
    ethereum: "eth",
    solana: "solana",
    arbitrum: "arbitrum",
    base: "base",
    optimism: "optimism",
    polygon: "polygon",
    gnosis: "gnosis",
    avalanche: "avalanche",
    "bnb-chain": "bsc",
};

const POSTHOG_SURVEY_ID = process.env.NEXT_PUBLIC_POSTHOG_ONBOARDING_SURVEY_ID;

const POSTHOG_SURVEY_QUESTION_IDS: Record<QuestionnaireBaseFieldName, string> =
    {
        "about.useCases":
            process.env
                .NEXT_PUBLIC_POSTHOG_ONBOARDING_SURVEY_QUESTION_USE_CASES_ID ??
            "",
        "about.networks":
            process.env
                .NEXT_PUBLIC_POSTHOG_ONBOARDING_SURVEY_QUESTION_NETWORKS_ID ??
            "",
        "about.biggestChallenges":
            process.env
                .NEXT_PUBLIC_POSTHOG_ONBOARDING_SURVEY_QUESTION_BIGGEST_CHALLENGES_ID ??
            "",
    };

const QUESTIONNAIRE_FIELD_ORDER: QuestionnaireBaseFieldName[] = [
    "about.useCases",
    "about.networks",
    "about.biggestChallenges",
];

export const ONBOARDING_QUESTIONNAIRE_STEP_COUNT =
    QUESTIONNAIRE_FIELD_ORDER.length;

function formatSurveyResponse(
    answer: { selected: string[]; other?: string },
    surveyLabelsById: Record<string, string>,
    selectionMode: QuestionnaireSelectionMode,
): string | string[] {
    const values = answer.selected.map((id) => {
        if (id === "other") {
            return answer.other?.trim() || SURVEY_OTHER_LABEL;
        }
        return surveyLabelsById[id] ?? id;
    });
    return selectionMode === "single" ? (values[0] ?? "") : values;
}

function buildCumulativeSurveyResponses(
    about: OnboardingAboutValues,
    steps: QuestionnaireStep[],
    activeStepIndex: number,
    skippedField?: QuestionnaireBaseFieldName,
): Record<string, string | string[]> {
    const responses: Record<string, string | string[]> = {};

    for (const [index, step] of steps.entries()) {
        if (index > activeStepIndex) continue;

        const questionId = POSTHOG_SURVEY_QUESTION_IDS[step.fieldName];
        if (!questionId) continue;

        if (step.fieldName === skippedField) {
            responses[`$survey_response_${questionId}`] =
                step.selectionMode === "single"
                    ? SURVEY_SKIP_LABEL
                    : [SURVEY_SKIP_LABEL];
            continue;
        }

        const fieldKey = step.fieldName.replace(
            "about.",
            "",
        ) as keyof OnboardingAboutValues;
        const answer = about[fieldKey];
        if (answer.selected.length === 0) {
            responses[`$survey_response_${questionId}`] =
                step.selectionMode === "single"
                    ? SURVEY_SKIP_LABEL
                    : [SURVEY_SKIP_LABEL];
            continue;
        }

        responses[`$survey_response_${questionId}`] = formatSurveyResponse(
            answer,
            step.surveyLabelsById,
            step.selectionMode,
        );
    }
    return responses;
}

export function OnboardingQuestionsStep({
    handleNext,
    startFromLastQuestion = false,
}: StepProps & { startFromLastQuestion?: boolean }) {
    const t = useTranslations("onboardingQuestions");
    const form = useFormContext<{ about: OnboardingAboutValues }>();
    const { data: chains = [] } = useChains();
    const [activeQuestionField, setActiveQuestionField] =
        useState<QuestionnaireBaseFieldName>(QUESTIONNAIRE_FIELD_ORDER[0]);
    const hasInitializedQuestionRef = useRef(false);
    const surveySubmissionIdRef = useRef(crypto.randomUUID());
    const surveyShownFiredRef = useRef(false);

    const buildOptions = useMemo(
        () =>
            (
                namespace: "useCases" | "networks" | "biggestChallenges",
                ids: readonly string[],
            ): QuestionnaireOption[] =>
                ids.map((id) => ({
                    id,
                    label: t(`options.${namespace}.${id}`),
                })),
        [t],
    );

    const questionnaireSteps: QuestionnaireStep[] = useMemo(
        () => [
            {
                title: t("stepTitle"),
                question: t("questions.useCases"),
                fieldName: "about.useCases",
                placeholder: t("placeholders.describeUseCase"),
                options: buildOptions("useCases", USE_CASE_OPTION_IDS),
                surveyLabelsById: SURVEY_ENGLISH_LABELS["about.useCases"],
                selectionMode: "multiple",
            },
            {
                title: "",
                question: t("questions.networks"),
                fieldName: "about.networks",
                placeholder: t("placeholders.networkName"),
                options: buildOptions("networks", NETWORK_OPTION_IDS),
                surveyLabelsById: SURVEY_ENGLISH_LABELS["about.networks"],
                selectionMode: "multiple",
            },
            {
                title: "",
                question: t("questions.biggestChallenges"),
                fieldName: "about.biggestChallenges",
                placeholder: t("placeholders.currentChallenge"),
                options: buildOptions(
                    "biggestChallenges",
                    BIGGEST_CHALLENGE_OPTION_IDS,
                ),
                surveyLabelsById:
                    SURVEY_ENGLISH_LABELS["about.biggestChallenges"],
                selectionMode: "multiple",
            },
        ],
        [t, buildOptions],
    );

    const isSurveyConfigReady = useMemo(() => {
        if (!POSTHOG_SURVEY_ID) return false;
        return QUESTIONNAIRE_FIELD_ORDER.every((field) =>
            Boolean(POSTHOG_SURVEY_QUESTION_IDS[field]),
        );
    }, []);
    const questionIndex = questionnaireSteps.findIndex(
        (step) => step.fieldName === activeQuestionField,
    );
    const currentQuestion =
        questionIndex === -1
            ? questionnaireSteps[0]
            : questionnaireSteps[questionIndex];
    const currentStepIndex = questionIndex === -1 ? 0 : questionIndex;
    const progressLabel = `${currentStepIndex + 1}/${questionnaireSteps.length}`;

    useEffect(() => {
        if (hasInitializedQuestionRef.current) return;
        if (!questionnaireSteps.length) return;

        setActiveQuestionField(
            startFromLastQuestion
                ? questionnaireSteps[questionnaireSteps.length - 1].fieldName
                : questionnaireSteps[0].fieldName,
        );
        hasInitializedQuestionRef.current = true;
    }, [startFromLastQuestion, questionnaireSteps]);

    useEffect(() => {
        if (!questionnaireSteps.length) return;
        if (
            questionnaireSteps.some(
                (step) => step.fieldName === activeQuestionField,
            )
        ) {
            return;
        }
        setActiveQuestionField(questionnaireSteps[0].fieldName);
    }, [activeQuestionField, questionnaireSteps]);

    useEffect(() => {
        if (!isSurveyConfigReady || !POSTHOG_SURVEY_ID) return;
        if (surveyShownFiredRef.current) return;
        surveyShownFiredRef.current = true;
        posthog.capture("survey shown", { $survey_id: POSTHOG_SURVEY_ID });
    }, [isSurveyConfigReady]);

    if (!currentQuestion) return null;

    const currentValue = form.watch(currentQuestion.fieldName) as
        | { selected: string[]; other?: string }
        | undefined;
    const selectedValues = currentValue?.selected ?? [];
    const hasOtherSelected = selectedValues.includes("other");
    const questionHasOtherOption = currentQuestion.options.some(
        (option) => option.id === "other",
    );
    const canContinue = selectedValues.length > 0;
    const chainByKey = useMemo(
        () => new Map(chains.map((chain) => [chain.key, chain])),
        [chains],
    );

    const updateSelection = (optionId: string) => {
        const isSelected = selectedValues.includes(optionId);
        const nextSelected =
            currentQuestion.selectionMode === "single"
                ? isSelected
                    ? selectedValues
                    : [optionId]
                : isSelected
                  ? selectedValues.filter((id) => id !== optionId)
                  : [...selectedValues, optionId];

        form.setValue(
            `${currentQuestion.fieldName}.selected` as QuestionnaireFieldName,
            nextSelected,
            { shouldDirty: true },
        );

        if (!nextSelected.includes("other")) {
            form.setValue(
                `${currentQuestion.fieldName}.other` as QuestionnaireFieldName,
                "",
                { shouldDirty: true },
            );
        }
    };

    const advanceQuestion = () => {
        const currentIndex = questionnaireSteps.findIndex(
            (step) => step.fieldName === activeQuestionField,
        );

        if (
            currentIndex === -1 ||
            currentIndex === questionnaireSteps.length - 1
        ) {
            handleNext?.();
            return;
        }
        setActiveQuestionField(questionnaireSteps[currentIndex + 1].fieldName);
    };

    const goToPreviousQuestion = () => {
        const currentIndex = questionnaireSteps.findIndex(
            (step) => step.fieldName === activeQuestionField,
        );
        if (currentIndex <= 0) return;
        setActiveQuestionField(questionnaireSteps[currentIndex - 1].fieldName);
    };

    const captureSurveyProgress = (
        skippedField?: QuestionnaireBaseFieldName,
    ) => {
        if (!isSurveyConfigReady || !POSTHOG_SURVEY_ID) return;
        const about = form.getValues("about");
        const idx = questionnaireSteps.findIndex(
            (s) => s.fieldName === activeQuestionField,
        );
        const isCompleted = idx !== -1 && idx === questionnaireSteps.length - 1;

        posthog.capture("survey sent", {
            $survey_id: POSTHOG_SURVEY_ID,
            $survey_submission_id: surveySubmissionIdRef.current,
            $survey_completed: isCompleted,
            ...buildCumulativeSurveyResponses(
                about,
                questionnaireSteps,
                idx === -1 ? 0 : idx,
                skippedField,
            ),
            ...(isCompleted && {
                $set: {
                    onboarding_use_cases: about.useCases.selected,
                    onboarding_networks: about.networks.selected,
                    onboarding_biggest_challenges:
                        about.biggestChallenges.selected,
                },
            }),
        });

        if (isCompleted) {
            trackEvent("onboarding_step_completed", {
                step_name: "about_you",
            });
        }
    };

    const moveNext = () => {
        captureSurveyProgress();
        advanceQuestion();
    };

    const handleSkip = () => {
        form.setValue(
            `${currentQuestion.fieldName}.selected` as QuestionnaireFieldName,
            [],
            { shouldDirty: true },
        );
        form.setValue(
            `${currentQuestion.fieldName}.other` as QuestionnaireFieldName,
            "",
            { shouldDirty: true },
        );
        captureSurveyProgress(currentQuestion.fieldName);
        advanceQuestion();
    };

    const renderedOptions = currentQuestion.options.map((option) => {
        const chainKey = NETWORK_OPTION_CHAIN_KEY[option.id];
        const chain = chainKey ? chainByKey.get(chainKey) : undefined;
        if (currentQuestion.fieldName !== "about.networks" || !chain) {
            return option;
        }
        return {
            ...option,
            iconSrc: chain.icon,
            iconImageClassName:
                option.id === NEAR_NETWORK_ID ? "p-0.5" : "rounded-full",
        };
    });

    return (
        <OnboardingQuestionnaireCard
            question={{
                title: currentQuestion.title,
                text: currentQuestion.question,
                progressLabel,
                options: renderedOptions,
                selectedValues,
                indicatorType:
                    currentQuestion.selectionMode === "single"
                        ? "radio"
                        : "checkbox",
                showOtherInput: hasOtherSelected && questionHasOtherOption,
                otherValue: currentValue?.other ?? "",
                otherPlaceholder:
                    currentQuestion.placeholder ??
                    t("placeholders.describeOther"),
                canContinue,
            }}
            actions={{
                onBack: goToPreviousQuestion,
                onOptionClick: updateSelection,
                onOtherChange: (value) => {
                    form.setValue(
                        `${currentQuestion.fieldName}.other` as QuestionnaireFieldName,
                        value,
                        { shouldDirty: true },
                    );
                },
                onContinue: moveNext,
                onSkip: handleSkip,
            }}
            showBack={currentStepIndex > 0}
        />
    );
}
