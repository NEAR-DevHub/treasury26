"use client";

import { useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import { type Control, useFieldArray, useWatch } from "react-hook-form";
import { Button } from "@/components/button";
import type { StepProps } from "@/components/step-wizard";
import { StepperHeader } from "@/components/step-wizard";
import { SummaryBlock } from "@/components/summary-block";
import { Textarea } from "@/components/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import type { AddressBookEntry } from "../types";
import {
    AddRecipientInput,
    type FormValues,
    RecipientRow,
} from "./add-recipient-form";

interface ReviewRecipientsProps extends StepProps {
    control: Control<FormValues>;
    existingEntries?: AddressBookEntry[];
    onSubmit: (
        notes: Record<number, string>,
        includedIndexes: number[],
    ) => void;
    isSubmitting?: boolean;
    initialNotes?: Record<number, string>;
}

export function ReviewRecipients({
    handleBack,
    control,
    existingEntries = [],
    onSubmit,
    isSubmitting = false,
    initialNotes,
}: ReviewRecipientsProps) {
    const t = useTranslations("addressBook.review");
    const [notes, setNotes] = useState<Record<number, string>>(
        initialNotes ?? {},
    );
    const [skipDuplicates, setSkipDuplicates] = useState(true);
    const [editingIndex, setEditingIndex] = useState<number | null>(null);
    const { fields, remove } = useFieldArray({ control, name: "recipients" });
    const recipients = useWatch({ control, name: "recipients" }) ?? [];
    const count = recipients.length;
    const existingAddresses = useMemo(
        () => new Set(existingEntries.map((entry) => entry.address.trim())),
        [existingEntries],
    );
    const duplicateIndexes = useMemo(() => {
        const seen = new Set<string>();
        const duplicates: number[] = [];
        for (let index = 0; index < recipients.length; index++) {
            const address = recipients[index]?.address?.trim();
            if (!address) continue;
            if (existingAddresses.has(address) || seen.has(address)) {
                duplicates.push(index);
            } else {
                seen.add(address);
            }
        }
        return duplicates;
    }, [existingAddresses, recipients]);
    const duplicateIndexSet = useMemo(
        () => new Set(duplicateIndexes),
        [duplicateIndexes],
    );
    const nonDuplicateRecipientIndexes = useMemo(
        () =>
            recipients.reduce<number[]>((included, _recipient, index) => {
                if (!duplicateIndexSet.has(index)) {
                    included.push(index);
                }

                return included;
            }, []),
        [duplicateIndexSet, recipients],
    );
    const duplicateCount = duplicateIndexes.length;
    const newRecipientCount = count - duplicateCount;
    const hasOnlyDuplicates = count > 0 && newRecipientCount === 0;
    const canSubmit =
        newRecipientCount > 0 && (duplicateCount === 0 || skipDuplicates);
    const includedRecipientIndexes = skipDuplicates
        ? nonDuplicateRecipientIndexes
        : recipients.map((_recipient, index) => index);
    const networkCount = new Set(
        includedRecipientIndexes.flatMap(
            (index) => recipients[index]?.networks ?? [],
        ),
    ).size;
    const submitTooltip =
        hasOnlyDuplicates && skipDuplicates
            ? t("allDuplicatesTooltip")
            : duplicateCount > 0 && !skipDuplicates
              ? t("duplicateActionTooltip")
              : undefined;

    if (editingIndex !== null) {
        return (
            <AddRecipientInput
                editOnly
                control={control}
                activeIndex={editingIndex}
                setActiveIndex={setEditingIndex}
                handleBack={() => setEditingIndex(null)}
                onReview={() => setEditingIndex(null)}
            />
        );
    }

    return (
        <div className="flex flex-col gap-4">
            <StepperHeader title={t("header")} handleBack={handleBack} />

            <div className="flex flex-col gap-3">
                <SummaryBlock
                    title={t("youAreAdding")}
                    secondRow={
                        <p className="text-2xl font-semibold text-foreground">
                            {t("newRecipients", { count: newRecipientCount })}
                        </p>
                    }
                    subRow={
                        count > 1 &&
                        newRecipientCount > 0 && (
                            <p className="text-sm text-muted-foreground">
                                {t("onNetworks", { count: networkCount })}
                            </p>
                        )
                    }
                />
                <div className="flex flex-col gap-1">
                    <p className="text-sm font-semibold">{t("recipients")}</p>
                    {duplicateCount > 0 && (
                        <p className="text-xs text-general-info-foreground font-medium">
                            {hasOnlyDuplicates
                                ? t("allDuplicates")
                                : t("someDuplicates", {
                                      duplicates: duplicateCount,
                                      total: count,
                                  })}
                        </p>
                    )}
                </div>

                {fields.map((field, i) => (
                    <div key={field.id} className="flex flex-col gap-2">
                        <RecipientRow
                            control={control}
                            index={i}
                            nameBadge={
                                duplicateIndexSet.has(i) ? (
                                    <span className="rounded-full bg-general-warning-background-faded px-2 py-0.5 text-xs font-medium text-general-warning-foreground">
                                        {t("duplicated")}
                                    </span>
                                ) : undefined
                            }
                            onEdit={() => setEditingIndex(i)}
                            onRemove={
                                count > 1
                                    ? () => {
                                          remove(i);
                                          setNotes((prev) => {
                                              const next: Record<
                                                  number,
                                                  string
                                              > = {};
                                              for (const [
                                                  k,
                                                  v,
                                              ] of Object.entries(prev)) {
                                                  const idx = Number(k);
                                                  if (idx < i) next[idx] = v;
                                                  else if (idx > i)
                                                      next[idx - 1] = v;
                                              }
                                              return next;
                                          });
                                      }
                                    : undefined
                            }
                        />
                        <Textarea
                            borderless
                            placeholder={t("notePlaceholder")}
                            value={notes[i] ?? ""}
                            onChange={(e) =>
                                setNotes((prev) => ({
                                    ...prev,
                                    [i]: e.target.value,
                                }))
                            }
                        />
                    </div>
                ))}
            </div>

            {duplicateCount > 0 && (
                <div className="flex items-start gap-3">
                    <Checkbox
                        id="skip-duplicates"
                        checked={skipDuplicates}
                        className="mt-0.5"
                        onCheckedChange={(checked) =>
                            setSkipDuplicates(checked === true)
                        }
                    />
                    <Label
                        htmlFor="skip-duplicates"
                        className="text-sm font-normal leading-relaxed cursor-pointer"
                    >
                        {t("skipDuplicates")}
                    </Label>
                </div>
            )}

            <Button
                className="w-full"
                disabled={isSubmitting || !canSubmit}
                tooltipContent={submitTooltip}
                onClick={() => onSubmit(notes, includedRecipientIndexes)}
            >
                {isSubmitting
                    ? t("adding")
                    : hasOnlyDuplicates
                      ? t("nothingNew")
                      : t("addRecipientsButton", {
                            count: newRecipientCount,
                        })}
            </Button>
        </div>
    );
}
