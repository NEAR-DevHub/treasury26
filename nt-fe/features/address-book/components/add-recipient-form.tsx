"use client";

import { useTranslations } from "next-intl";
import { useState, useEffect, useCallback, type ReactNode, useId } from "react";
import {
    useWatch,
    useFieldArray,
    useFormContext,
    type Control,
} from "react-hook-form";
import { z } from "zod";
import { Plus, Pencil, Trash2, FileUp } from "lucide-react";
import { InputBlock } from "@/components/input-block";
import { LargeInput } from "@/components/large-input";
import AccountInput from "@/components/account-input";
import { Button } from "@/components/button";
import { NetworkList } from "@/components/network-list";
import { StepperHeader } from "@/components/step-wizard";
import { useChains } from "../chains";
import { getCompatibleChains } from "../compatible-chains";
import {
    SelectModal,
    type SelectOption,
} from "@/app/(treasury)/[treasuryId]/dashboard/components/select-modal";
import { FormField, FormItem, FormMessage } from "@/components/ui/form";
import { NumberBadge } from "@/components/number-badge";
import { Address } from "@/components/address";
import { Pill } from "@/components/pill";
import { buildRecipientSchema, RECIPIENT_NAME_MAX_LENGTH } from "../types";
import { useMediaQuery } from "@/hooks/use-media-query";

// ─── Form schema ───────────────────────────────────────────────────────────────

export function buildFormSchema(messages: {
    nameRequired: string;
    nameMax: string;
    addressRequired: string;
    networksRequired: string;
}) {
    return z.object({
        recipients: z.array(buildRecipientSchema(messages)),
    });
}

const _formSchemaForType = buildFormSchema({
    nameRequired: "",
    nameMax: "",
    addressRequired: "",
    networksRequired: "",
});

export type FormValues = z.infer<typeof _formSchemaForType>;

// ─── NetworkSelect ─────────────────────────────────────────────────────────────

function NetworkSelect({
    address,
    selected,
    onChange,
    disabled,
}: {
    address: string;
    selected: string[];
    onChange: (networks: string[]) => void;
    disabled?: boolean;
}) {
    const tForm = useTranslations("addressBook.form");
    const { data: chains = [], isLoading } = useChains();
    const [open, setOpen] = useState(false);

    const compatibleChains = getCompatibleChains(address, chains);
    const isMobile = useMediaQuery("(max-width: 768px)");

    const options = compatibleChains.map((c) => ({
        id: c.key,
        name: c.name,
        icon: c.icon,
    }));

    const selectedChains = chains.filter((c) => selected.includes(c.key));

    const handleSelect = (option: SelectOption) => {
        if (selected.includes(option.id)) {
            onChange(selected.filter((k) => k !== option.id));
        } else {
            onChange([...selected, option.id]);
        }
    };

    useEffect(() => {
        if (
            !disabled &&
            compatibleChains.length === 1 &&
            selected.length === 0
        ) {
            handleSelect({
                id: compatibleChains[0].key,
                name: compatibleChains[0].name,
                icon: compatibleChains[0].icon,
            });
        }
    }, [compatibleChains.length]);

    return (
        <>
            <div
                role="button"
                tabIndex={disabled ? -1 : 0}
                onClick={() => !disabled && setOpen(true)}
                onKeyDown={(event) => {
                    if (disabled) return;
                    if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setOpen(true);
                    }
                }}
                aria-disabled={disabled}
                className="flex w-full items-center py-1 focus:outline-none data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-40"
                data-disabled={disabled}
            >
                {selectedChains.length === 0 ? (
                    <span className="text-muted-foreground text-lg">
                        {disabled
                            ? tForm("enterAddressFirst")
                            : tForm("selectNetwork")}
                    </span>
                ) : (
                    <NetworkList
                        chains={selectedChains}
                        className="gap-1.5"
                        badgeSize={isMobile ? "sm" : "lg"}
                    />
                )}
            </div>
            <SelectModal
                multiSelect
                isOpen={open}
                onClose={() => setOpen(false)}
                onSelect={handleSelect}
                title={tForm("selectNetworksTitle")}
                options={options}
                searchPlaceholder={tForm("searchNetworksPlaceholder")}
                isLoading={isLoading}
                selectedIds={selected}
            />
        </>
    );
}

// ─── RecipientRow ──────────────────────────────────────────────────────────────

export function RecipientRow({
    control,
    index,
    onEdit,
    onRemove,
    nameBadge,
    invalid,
}: {
    control: Control<FormValues>;
    index: number;
    onEdit?: () => void;
    onRemove?: () => void;
    nameBadge?: ReactNode;
    invalid?: boolean;
}) {
    const tForm = useTranslations("addressBook.form");
    const { data: chains = [] } = useChains();
    const name = useWatch({ control, name: `recipients.${index}.name` });
    const address = useWatch({ control, name: `recipients.${index}.address` });
    const networks = useWatch({
        control,
        name: `recipients.${index}.networks`,
    });

    const recipientChains = chains.filter((c) => networks.includes(c.key));

    return (
        <div className="flex flex-col gap-2">
            <div className="flex gap-2 items-start py-0.5">
                <div className="my-auto">
                    <NumberBadge number={index + 1} variant="secondary" />
                </div>
                <div className="flex flex-1 flex-col items-end min-w-0">
                    <div className="flex items-center gap-2 w-full">
                        <div className="flex flex-1 items-start gap-1 min-w-0">
                            <div className="flex items-center gap-2">
                                <div className="flex flex-1 flex-col gap-0 leading-none min-w-0 max-w-36 md:max-w-72">
                                    <p className="text-sm font-medium truncate">
                                        {name}
                                    </p>
                                    <div className="text-xxs text-muted-foreground">
                                        <Address address={address} />
                                    </div>
                                </div>
                                {nameBadge}
                                {invalid && (
                                    <Pill
                                        title={tForm("incomplete")}
                                        className="bg-destructive/10 text-destructive"
                                    />
                                )}
                            </div>
                        </div>
                        <NetworkList
                            chains={recipientChains}
                            className="shrink-0"
                            badgeVariant="secondary"
                            badgeIconOnly
                            maxVisible={2}
                            badgeSize="sm"
                        />
                    </div>
                </div>
            </div>
            {(onEdit || onRemove) && (
                <div className="flex gap-0.5 py-1 justify-end">
                    {onEdit && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={onEdit}
                        >
                            <Pencil className="size-4" />
                            {tForm("edit")}
                        </Button>
                    )}
                    {onRemove && (
                        <Button
                            variant="ghost"
                            size="sm"
                            className="text-muted-foreground hover:text-foreground"
                            onClick={onRemove}
                        >
                            <Trash2 className="size-4" />
                            {tForm("remove")}
                        </Button>
                    )}
                </div>
            )}
        </div>
    );
}

// ─── AddRecipientInput ─────────────────────────────────────────────────────────

const EMPTY_RECIPIENT = { name: "", networks: [] as string[], address: "" };

interface AddRecipientInputProps {
    control: Control<FormValues>;
    activeIndex: number;
    setActiveIndex: (index: number) => void;
    handleBack?: () => void;
    onReview: () => void;
    onImport?: () => void;
    /** When true, only show the form fields + a "Done" button — hides the committed list, "Add Another", stepper header, and "Review Details". */
    editOnly?: boolean;
}

export function AddRecipientInput({
    control,
    activeIndex,
    setActiveIndex,
    handleBack,
    onReview,
    onImport,
    editOnly = false,
}: AddRecipientInputProps) {
    const tForm = useTranslations("addressBook.form");
    const { data: chains = [] } = useChains();
    const [isAddressValid, setIsAddressValid] = useState(false);
    const [isAddressValidating, setIsAddressValidating] = useState(false);

    const { formState, setError, clearErrors, getValues, setValue } =
        useFormContext<FormValues>();

    const { fields, append, remove } = useFieldArray({
        control,
        name: "recipients",
    });
    const id = useId();

    const activeAddress = useWatch({
        control,
        name: `recipients.${activeIndex}.address`,
    });
    const activeFormKey = `${activeIndex}-${id}`;
    const activeNetworks = useWatch({
        control,
        name: `recipients.${activeIndex}.networks`,
    });
    const allRecipients = useWatch({ control, name: "recipients" }) ?? [];

    const isActiveValid =
        !formState.errors.recipients?.[activeIndex] &&
        !!getValues(`recipients.${activeIndex}.name`)?.trim() &&
        isAddressValid &&
        !isAddressValidating &&
        activeNetworks?.length > 0;

    const isEntryComplete = (i: number) => {
        const r = allRecipients[i];
        if (!r) return false;
        return (
            !!r.name?.trim() &&
            !!r.address &&
            r.networks?.length > 0 &&
            !formState.errors.recipients?.[i]
        );
    };

    const canProceed =
        isActiveValid &&
        fields.every((_, i) => i === activeIndex || isEntryComplete(i));

    const handleAddressValid = useCallback(
        (valid: boolean) => {
            if (!valid) {
                setIsAddressValid(false);
                if (activeAddress) {
                    setError(`recipients.${activeIndex}.address`, {
                        message: tForm("invalidAddress"),
                    });
                }
                return;
            }
            const compatible = getCompatibleChains(activeAddress, chains);
            if (compatible.length > 0) {
                setIsAddressValid(true);
                clearErrors(`recipients.${activeIndex}.address`);
                const compatibleKeys = compatible.map((c) => c.key);
                const currentNetworks = getValues(
                    `recipients.${activeIndex}.networks`,
                );
                const stillValid = currentNetworks.filter((n) =>
                    compatibleKeys.includes(n),
                );
                if (stillValid.length !== currentNetworks.length) {
                    setValue(`recipients.${activeIndex}.networks`, stillValid);
                }
            } else {
                setIsAddressValid(false);
                setError(`recipients.${activeIndex}.address`, {
                    message: tForm("noCompatibleNetworks"),
                });
            }
        },
        [
            activeAddress,
            chains,
            activeIndex,
            setError,
            clearErrors,
            getValues,
            setValue,
        ],
    );

    const handleCommit = () => {
        if (!isActiveValid) return;
        append(EMPTY_RECIPIENT);
        setActiveIndex(fields.length);
        setIsAddressValid(false);
    };

    const handleEdit = (index: number) => {
        setActiveIndex(index);
        setIsAddressValid(false);
    };

    const handleRemove = (index: number) => {
        remove(index);
        const nextLength = fields.length - 1;
        const nextActive = activeIndex > index ? activeIndex - 1 : activeIndex;
        setActiveIndex(Math.max(0, Math.min(nextActive, nextLength - 1)));
    };

    return (
        <div className="flex flex-col gap-4">
            <div className="flex gap-3 justify-between items-center">
                <StepperHeader
                    title={
                        editOnly
                            ? tForm("editRecipient")
                            : tForm("addRecipient")
                    }
                    handleBack={handleBack}
                />
                {!editOnly && onImport && (
                    <Button variant={"outline"} onClick={onImport}>
                        <FileUp className="size-4" /> {tForm("import")}
                    </Button>
                )}
            </div>

            <div key={activeFormKey} className="flex flex-col gap-2">
                <FormField
                    control={control}
                    name={`recipients.${activeIndex}.name`}
                    render={({ field, fieldState }) => (
                        <FormItem>
                            <InputBlock
                                title={tForm("recipientName")}
                                invalid={!!fieldState.error}
                                interactive
                            >
                                <LargeInput
                                    borderless
                                    placeholder={tForm("namePlaceholder")}
                                    maxLength={RECIPIENT_NAME_MAX_LENGTH}
                                    {...field}
                                />
                                <FormMessage />
                            </InputBlock>
                        </FormItem>
                    )}
                />

                <FormField
                    control={control}
                    name={`recipients.${activeIndex}.address`}
                    render={({ field, fieldState }) => (
                        <FormItem>
                            <InputBlock
                                title={tForm("recipientAddress")}
                                invalid={!!fieldState.error}
                                interactive
                            >
                                <AccountInput
                                    blockchain="unknown"
                                    value={activeAddress}
                                    setValue={field.onChange}
                                    setIsValid={handleAddressValid}
                                    setIsValidating={setIsAddressValidating}
                                    validateOnMount={!!activeAddress}
                                    borderless
                                />
                                <FormMessage />
                            </InputBlock>
                        </FormItem>
                    )}
                />

                <FormField
                    control={control}
                    name={`recipients.${activeIndex}.networks`}
                    render={({ field, fieldState }) => (
                        <FormItem>
                            <InputBlock
                                title={tForm("network")}
                                info={tForm("networkInfo")}
                                invalid={!!fieldState.error}
                                interactive
                                disabled={!isAddressValid}
                            >
                                <NetworkSelect
                                    address={activeAddress}
                                    selected={field.value ?? []}
                                    onChange={field.onChange}
                                    disabled={!isAddressValid}
                                />
                                <FormMessage />
                            </InputBlock>
                        </FormItem>
                    )}
                />
            </div>

            {editOnly ? (
                <Button
                    className="w-full"
                    disabled={!isActiveValid}
                    onClick={onReview}
                >
                    {tForm("done")}
                </Button>
            ) : (
                <>
                    <Button
                        variant="ghost"
                        type="button"
                        className="w-full justify-start rounded-b-xl"
                        disabled={!isActiveValid}
                        tooltipContent={
                            !isActiveValid ? tForm("fillAllTooltip") : undefined
                        }
                        onClick={handleCommit}
                    >
                        <Plus className="size-4 text-foreground" />
                        <span className="text-foreground">
                            {tForm("addAnother")}
                        </span>
                    </Button>

                    {fields.length > 0 && (
                        <div className="flex flex-col divide-y">
                            {fields.map((field, i) =>
                                i !== activeIndex ? (
                                    <RecipientRow
                                        key={field.id}
                                        index={i}
                                        control={control}
                                        onEdit={() => handleEdit(i)}
                                        onRemove={() => handleRemove(i)}
                                        invalid={!isEntryComplete(i)}
                                    />
                                ) : null,
                            )}
                        </div>
                    )}

                    <div className="rounded-lg border bg-card p-0 overflow-hidden">
                        <Button
                            className="w-full"
                            disabled={!canProceed}
                            tooltipContent={
                                !canProceed ? tForm("reviewTooltip") : undefined
                            }
                            onClick={onReview}
                        >
                            {tForm("reviewDetails")}
                        </Button>
                    </div>
                </>
            )}
        </div>
    );
}
