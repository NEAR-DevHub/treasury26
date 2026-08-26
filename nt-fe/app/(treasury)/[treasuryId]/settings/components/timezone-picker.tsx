"use client";

import { Icon } from "@/components/icon";
import { ArrowDown01Icon, CheckIcon } from "@hugeicons/core-free-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/button";
import { HighlightedText } from "@/components/highlighted-text";
import { Input } from "@/components/input";
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { Timezone } from "@/lib/api";
import { cn } from "@/lib/utils";

function formatTimezoneLabel(tz: Timezone): string {
    return `(${tz.utc}) ${tz.value}`;
}

interface TimezonePickerProps {
    value: Timezone | null;
    timezones: Timezone[];
    isLoading?: boolean;
    disabled?: boolean;
    onChange: (timezone: Timezone) => void;
}

export function TimezonePicker({
    value,
    timezones,
    isLoading = false,
    disabled = false,
    onChange,
}: TimezonePickerProps) {
    const t = useTranslations("settings.preferences");
    const [open, setOpen] = useState(false);
    const [search, setSearch] = useState("");
    const searchRef = useRef<HTMLInputElement>(null);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const [triggerWidth, setTriggerWidth] = useState<number>();
    const isSmallScreen = useMediaQuery("(max-width: 639px)");

    const filteredTimezones = useMemo(() => {
        const query = search.trim().toLowerCase();
        if (!query) return timezones;
        return timezones.filter(
            (tz) =>
                tz.value.toLowerCase().includes(query) ||
                tz.utc.toLowerCase().includes(query) ||
                tz.name.toLowerCase().includes(query),
        );
    }, [timezones, search]);

    useEffect(() => {
        if (!open) return;
        const width = triggerRef.current?.offsetWidth;
        if (width) setTriggerWidth(width);
    }, [open]);

    return (
        <Popover
            open={open}
            onOpenChange={(nextOpen) => {
                setOpen(nextOpen);
                if (!nextOpen) setSearch("");
            }}
        >
            <PopoverTrigger asChild>
                <Button
                    ref={triggerRef}
                    type="button"
                    variant="outline"
                    disabled={disabled}
                    className="w-full justify-between font-normal overflow-hidden"
                >
                    <span className="truncate min-w-0 text-left">
                        {isLoading
                            ? t("loadingTimezones")
                            : value
                              ? formatTimezoneLabel(value)
                              : t("selectTimezone")}
                    </span>
                    <Icon
                        icon={ArrowDown01Icon}
                        className="shrink-0 opacity-50"
                    />
                </Button>
            </PopoverTrigger>
            <PopoverContent
                align={isSmallScreen ? "center" : "start"}
                className="p-2"
                style={
                    triggerWidth
                        ? { width: triggerWidth, maxWidth: triggerWidth }
                        : undefined
                }
                onOpenAutoFocus={(e) => {
                    e.preventDefault();
                    searchRef.current?.focus();
                }}
            >
                <Input
                    ref={searchRef}
                    search
                    placeholder={t("searchTimezones")}
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                />
                <ScrollArea className="mt-2 h-75">
                    {filteredTimezones.length > 0 ? (
                        <div className="flex flex-col gap-0.5">
                            {filteredTimezones.map((tz) => {
                                const selected = value?.name === tz.name;
                                return (
                                    <button
                                        key={tz.name}
                                        type="button"
                                        className={cn(
                                            "flex w-full items-start gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent hover:text-accent-foreground",
                                            selected &&
                                                "bg-accent text-accent-foreground",
                                        )}
                                        onClick={() => {
                                            onChange(tz);
                                            setOpen(false);
                                            setSearch("");
                                        }}
                                    >
                                        <Icon
                                            icon={CheckIcon}
                                            className={cn(
                                                "mt-0.5 shrink-0",
                                                selected
                                                    ? "opacity-100"
                                                    : "opacity-0",
                                            )}
                                        />
                                        <HighlightedText
                                            text={formatTimezoneLabel(tz)}
                                            query={search}
                                            className="min-w-0 whitespace-normal wrap-break-word"
                                        />
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="py-6 text-center text-sm text-muted-foreground">
                            {t("noTimezones")}
                        </div>
                    )}
                </ScrollArea>
            </PopoverContent>
        </Popover>
    );
}
