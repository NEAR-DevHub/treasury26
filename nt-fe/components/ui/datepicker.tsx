'use client';


import {
    addMonths,
    endOfDay,
    endOfMonth,
    endOfYear,
    format,
    getMonth,
    getYear,
    setMonth as setMonthFns,
    setYear,
    startOfDay,
    startOfMonth,
    startOfYear,
    subDays,
    subMonths,
} from 'date-fns';
import {
    Calendar,
    ChevronDownIcon,
    ChevronLeftIcon,
    ChevronRightIcon,
    ChevronUpIcon,
    XCircle,
} from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { DayPicker, type DateRange, type Matcher, TZDate } from 'react-day-picker';

import { Button, buttonVariants } from '@/components/ui/button';

interface SelectOption {
    value: number;
    label: string;
    disabled: boolean;
}

import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

import { Tooltip } from "@/components/tooltip";
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

export type CalendarProps = Omit<
    React.ComponentProps<typeof DayPicker>,
    'mode' | 'selected' | 'onSelect'
>;


export type DateTimePickerProps = {
    /**
     * The datetime value to display and control.
     */
    value: Date | DateRange | undefined;
    /**
     * Callback function to handle datetime changes.
     */
    onChange: (date: Date | DateRange | undefined) => void;
    /**
     * The selection mode - single date or date range.
     * @default 'single'
     */
    mode?: 'single' | 'range';
    /**
     * The default month to display.
     * @default undefined
     */
    defaultMonth?: Date;
    /**
     * The number of months to display.
     * @default 1
     */
    numberOfMonths?: number;
    /**
     * Preset date ranges to show when in range mode.
     */
    presets?: Array<{
        label: string;
        value: DateRange;
    }>;
    /**
     * The minimum datetime value allowed.
     * @default undefined
     */
    min?: Date;
    /**
     * The maximum datetime value allowed.
     */
    max?: Date;
    /**
     * The timezone to display the datetime in, based on the date-fns.
     * For a complete list of valid time zone identifiers, refer to:
     * https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
     * @default undefined
     */
    timezone?: string;
    /**
     * Whether the datetime picker is disabled.
     * @default false
     */
    disabled?: boolean;
    /**
     * Whether to show the calendar icon.
     * @default true
     */
    showCalendarIcon?: boolean;
    /**
     * Whether to show the clear button.
     * @default false
     */
    clearable?: boolean;
    /**
     * Whether to use borderless styling.
     * @default false
     */
    borderless?: boolean;
    /**
     * Placeholder text to show when no date is selected.
     * @default "Pick a date"
     */
    placeholder?: string;
    /**
     * Custom class names for the component.
     */
    classNames?: {
        /**
         * Custom class names for the trigger (the button that opens the picker).
         */
        trigger?: string;
    };
    /**
     * Content to show in tooltip for dates before minDate
     */
    minDateTooltipContent?: string;

    /**
     * Content to show in tooltip for dates after maxDate
     */
    maxDateTooltipContent?: string;
};

export type DateTimeRenderTriggerProps = {
    value: Date | DateRange | undefined;
    open: boolean;
    timezone?: string;
    disabled?: boolean;
    setOpen: (open: boolean) => void;
};

export function DateTimePicker({
    value,
    onChange,
    min,
    max,
    timezone,
    disabled,
    showCalendarIcon = true,
    clearable,
    borderless,
    placeholder = 'Pick a date',
    classNames,
    minDateTooltipContent,
    maxDateTooltipContent,
    mode = 'single',
    defaultMonth,
    numberOfMonths,
    presets,
    ...props
}: DateTimePickerProps & CalendarProps) {
    // Helper to check if value is a range
    const isRange = (val: Date | DateRange | undefined): val is DateRange => {
        return mode === 'range' && val !== undefined && typeof val === 'object' && 'from' in val;
    };

    const [open, setOpen] = useState(false);
    const [monthYearPicker, setMonthYearPicker] = useState<
        'month' | 'year' | false
    >(false);
    const initDate = useMemo(
        () => new TZDate((isRange(value) ? value.from : value) || new Date(), timezone),
        [value, timezone, isRange],
    );

    const [month, setMonth] = useState<Date>(initDate);

    const endMonth = useMemo(() => {
        return setYear(month, getYear(month) + 1);
    }, [month]);
    const minDate = useMemo(
        () => (min ? new TZDate(min, timezone) : undefined),
        [min, timezone],
    );
    const maxDate = useMemo(
        () => (max ? new TZDate(max, timezone) : undefined),
        [max, timezone],
    );

    const onDayChanged = useCallback(
        (d: Date | DateRange | undefined) => {
            if (!d) return;

            if (mode === 'range' && typeof d === 'object' && 'from' in d) {
                // Handle range selection - automatically set startOfDay and endOfDay
                const range = d as DateRange;
                const newRange: DateRange = {
                    from: range.from ? startOfDay(range.from) : undefined,
                    to: range.to ? endOfDay(range.to) : undefined
                };
                onChange(newRange);
            } else {
                // Handle single date selection
                const newDate = new Date(d as Date);
                // For single dates, set to start of day
                const startOfDayDate = startOfDay(newDate);
                onChange(startOfDayDate);
            }
        },
        [onChange, mode],
    );

    const onMonthYearChanged = useCallback(
        (d: Date, mode: 'month' | 'year') => {
            setMonth(d);
            if (mode === 'year') {
                setMonthYearPicker('month');
            } else {
                setMonthYearPicker(false);
            }
        },
        [setMonth, setMonthYearPicker],
    );
    const onNextMonth = useCallback(() => {
        setMonth(addMonths(month, 1));
    }, [month]);
    const onPrevMonth = useCallback(() => {
        setMonth(subMonths(month, 1));
    }, [month]);

    useEffect(() => {
        if (open) {
            setMonth(initDate);
            setMonthYearPicker(false);
        }
    }, [open, initDate]);

    return (
        <div className="flex w-auto">
            {/* Preset buttons for range mode */}
            {mode === 'range' && presets && presets.length > 0 && (
                <div className="pr-3">
                    <div className="grid">
                        {presets.map((preset, index) => (
                            <Button
                                key={index}
                                variant="ghost"
                                className="justify-start text-sm px-2"
                                onClick={() => onDayChanged(preset.value)}
                            >
                                {preset.label}
                            </Button>
                        ))}
                    </div>
                </div>
            )}
            <div>
                <div className="flex items-center justify-between w-auto">
                    <div className="ms-2 flex cursor-pointer items-center text-sm font-medium">
                        <div>
                            <span
                                onClick={() =>
                                    setMonthYearPicker(
                                        monthYearPicker === 'month' ? false : 'month',
                                    )
                                }
                            >
                                {format(month, 'MMMM')}
                            </span>
                            <span
                                className="ms-1"
                                onClick={() =>
                                    setMonthYearPicker(
                                        monthYearPicker === 'year' ? false : 'year',
                                    )
                                }
                            >
                                {format(month, 'yyyy')}
                            </span>
                        </div>
                        <Button
                            variant="ghost"
                            size="icon"
                            onClick={() =>
                                setMonthYearPicker(monthYearPicker ? false : 'year')
                            }
                        >
                            {monthYearPicker ? <ChevronUpIcon /> : <ChevronDownIcon />}
                        </Button>
                    </div>
                    <div
                        className={cn('flex space-x-2', monthYearPicker ? 'hidden' : '')}
                    >
                        <Button variant="ghost" size="icon" onClick={onPrevMonth}>
                            <ChevronLeftIcon />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={onNextMonth}>
                            <ChevronRightIcon />
                        </Button>
                    </div>
                </div>


                <div className="relative overflow-hidden">
                    <DayPicker
                        timeZone={timezone}
                        mode={mode as any}
                        selected={value as any}
                        onSelect={onDayChanged}
                        month={month}
                        endMonth={endMonth}
                        defaultMonth={defaultMonth}
                        numberOfMonths={numberOfMonths}
                        required={mode === 'range' ? true as any : undefined}
                        disabled={
                            [
                                max ? { after: max } : null,
                                min ? { before: min } : null,
                            ].filter(Boolean) as Matcher[]
                        }
                        onMonthChange={setMonth}
                        components={{
                            Day: (props) => {
                                const date = props.day.date;
                                const isDisabledBefore = min && date < min;
                                const isDisabledAfter = max && date > max;

                                if (
                                    (isDisabledBefore && minDateTooltipContent) ||
                                    (isDisabledAfter && maxDateTooltipContent)
                                ) {
                                    return (
                                        <Tooltip
                                            content={
                                                isDisabledBefore
                                                    ? minDateTooltipContent
                                                    : maxDateTooltipContent
                                            }
                                            contentProps={{ className: 'max-w-56 text-center' }}
                                        >
                                            <div {...props} />
                                        </Tooltip>
                                    );
                                }
                                return <div {...props} />;
                            },
                        }}
                        classNames={{
                            dropdowns: 'flex w-full gap-2',
                            months: 'flex w-full h-fit',
                            month: 'flex flex-col w-full',
                            month_caption: 'hidden',
                            button_previous: 'hidden',
                            button_next: 'hidden',
                            month_grid: 'w-full border-collapse',
                            weekdays: 'flex justify-between mt-2',
                            weekday:
                                'text-muted-foreground rounded-md w-9 font-normal text-[0.8rem]',
                            week: 'flex w-full justify-between mt-2',
                            day: 'h-9 w-9 text-center text-sm p-0 relative flex items-center justify-center [&:has([aria-selected].day-range-end)]:rounded-r-md [&:has([aria-selected].day-outside)]:bg-accent/50 [&:has([aria-selected])]:bg-accent first:[&:has([aria-selected])]:rounded-l-md last:[&:has([aria-selected])]:rounded-r-md focus-within:relative focus-within:z-20 rounded-1',
                            day_button: cn(
                                buttonVariants({ variant: 'ghost' }),
                                'size-9 p-0 font-normal aria-selected:opacity-100 rounded-md focus-visible:ring-0',
                                mode === 'range' && 'hover:rounded-none [.day-range-start_&]:hover:rounded-l-md [.day-range-start_&]:hover:rounded-r-none [.day-range-end_&]:hover:rounded-r-md [.day-range-end_&]:hover:rounded-l-none',
                            ),
                            range_end: 'day-range-end rounded-r-md',
                            range_start: 'day-range-start rounded-l-md',
                            selected:
                                cn('bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground rounded-none', !isRange(value) && 'rounded-md'),
                            today: 'bg-accent text-accent-foreground rounded-md',
                            outside:
                                'day-outside text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30',
                            disabled: 'text-muted-foreground opacity-50',
                            range_middle:
                                'aria-selected:bg-general-tertiary aria-selected:text-accent-foreground',
                            hidden: 'invisible',
                        }}
                        showOutsideDays={true}
                        {...props}
                    />
                    <div
                        className={cn(
                            'absolute bottom-0 left-0 right-0 top-0',
                            monthYearPicker ? 'bg-popover' : 'hidden',
                        )}
                    ></div>
                    <MonthYearPicker
                        value={month}
                        mode={monthYearPicker as any}
                        onChange={onMonthYearChanged}
                        minDate={minDate}
                        maxDate={maxDate}
                        className={cn(
                            'absolute bottom-0 left-0 right-0 top-0',
                            monthYearPicker ? '' : 'hidden',
                        )}
                    />
                </div>
                {timezone && (
                    <div className="mt-2 text-sm">
                        <span>Timezone:</span>
                        <span className="ms-1 font-semibold">{timezone}</span>
                    </div>
                )}
            </div>
        </div>
    );
}

function MonthYearPicker({
    value,
    minDate,
    maxDate,
    mode = 'month',
    onChange,
    className,
}: {
    value: Date;
    mode: 'month' | 'year';
    minDate?: Date;
    maxDate?: Date;
    onChange: (value: Date, mode: 'month' | 'year') => void;
    className?: string;
}) {
    const years = useMemo(() => {
        const years: SelectOption[] = [];
        for (let i = 1912; i < 2100; i++) {
            let disabled = false;
            const startY = startOfYear(setYear(value, i));
            const endY = endOfYear(setYear(value, i));
            if (minDate && endY < minDate) disabled = true;
            if (maxDate && startY > maxDate) disabled = true;
            years.push({ value: i, label: i.toString(), disabled });
        }
        return years;
    }, [value]);
    const months = useMemo(() => {
        const months: SelectOption[] = [];
        for (let i = 0; i < 12; i++) {
            let disabled = false;
            const startM = startOfMonth(setMonthFns(value, i));
            const endM = endOfMonth(setMonthFns(value, i));
            if (minDate && endM < minDate) disabled = true;
            if (maxDate && startM > maxDate) disabled = true;
            months.push({ value: i, label: format(new Date(0, i), 'MMM'), disabled });
        }
        return months;
    }, [value]);

    const onYearChange = useCallback(
        (v: SelectOption) => {
            let newDate = setYear(value, v.value);
            if (minDate && newDate < minDate) {
                newDate = setMonthFns(newDate, getMonth(minDate));
            }
            if (maxDate && newDate > maxDate) {
                newDate = setMonthFns(newDate, getMonth(maxDate));
            }
            onChange(newDate, 'year');
        },
        [onChange, value, minDate, maxDate],
    );

    useEffect(() => {
        if (mode === 'year') {
            // Scroll to selected year after a brief delay to ensure DOM is ready
            const timeoutId = setTimeout(() => {
                const selectedYearElement = document.querySelector(`[data-year="${getYear(value)}"]`);
                selectedYearElement?.scrollIntoView({ behavior: 'auto', block: 'center' });
            }, 10);
            return () => clearTimeout(timeoutId);
        }
    }, [mode, value]);
    return (
        <div className={cn(className)}>
            <ScrollArea className="h-full">
                {mode === 'year' && (
                    <div className="grid grid-cols-4">
                        {years.map((year) => (
                            <div
                                key={year.value}
                                data-year={year.value}
                            >
                                <Button
                                    disabled={year.disabled}
                                    variant={getYear(value) === year.value ? 'default' : 'ghost'}
                                    className="rounded-full"
                                    onClick={() => onYearChange(year)}
                                >
                                    {year.label}
                                </Button>
                            </div>
                        ))}
                    </div>
                )}
                {mode === 'month' && (
                    <div className="grid grid-cols-3 gap-4">
                        {months.map((month) => (
                            <Button
                                key={month.value}
                                size="lg"
                                disabled={month.disabled}
                                variant={getMonth(value) === month.value ? 'default' : 'ghost'}
                                className="rounded-full"
                                onClick={() =>
                                    onChange(setMonthFns(value, month.value), 'month')
                                }
                            >
                                {month.label}
                            </Button>
                        ))}
                    </div>
                )}
            </ScrollArea>
        </div>
    );
}

export type DatePickerPopoverProps = Omit<DateTimePickerProps, 'classNames'> & {
    /**
     * Custom class names for the component.
     */
    classNames?: {
        /**
         * Custom class names for the trigger button.
         */
        trigger?: string;
        /**
         * Custom class names for the popover content.
         */
        content?: string;
    };
    /**
     * Alignment of the popover relative to the trigger.
     * @default "start"
     */
    align?: 'start' | 'center' | 'end';
    /**
     * Side of the trigger where the popover should appear.
     * @default "bottom"
     */
    side?: 'top' | 'right' | 'bottom' | 'left';
};

export function DatePickerPopover({
    value,
    onChange,
    mode = 'single',
    disabled,
    showCalendarIcon = true,
    clearable,
    borderless,
    placeholder = 'Pick a date',
    classNames,
    align = 'start',
    side = 'bottom',
    ...dateTimePickerProps
}: DatePickerPopoverProps) {
    const [open, setOpen] = useState(false);

    // Helper to check if value is a range
    const isRange = (val: Date | DateRange | undefined): val is DateRange => {
        return mode === 'range' && val !== undefined && typeof val === 'object' && 'from' in val;
    };

    // Format display value
    const getDisplayValue = () => {
        if (!value) return placeholder;

        if (isRange(value)) {
            if (value.from && value.to) {
                return `${format(value.from, 'MMM dd, yyyy')} - ${format(value.to, 'MMM dd, yyyy')}`;
            }
            if (value.from) {
                return `${format(value.from, 'MMM dd, yyyy')} - ...`;
            }
            return placeholder;
        }

        return format(value as Date, 'MMM dd, yyyy');
    };

    // Handle clear action
    const handleClear = (e: React.MouseEvent) => {
        e.stopPropagation();
        onChange(undefined);
    };

    return (
        <Popover open={open} onOpenChange={setOpen}>
            <PopoverTrigger asChild>
                <Button
                    variant={borderless ? 'ghost' : 'outline'}
                    className={cn(
                        'w-full justify-start text-left font-normal',
                        !value && 'text-muted-foreground',
                        borderless && 'border-none shadow-none hover:bg-transparent',
                        classNames?.trigger
                    )}
                    disabled={disabled}
                >
                    {showCalendarIcon && <Calendar className="mr-2 h-4 w-4" />}
                    <span className="flex-1">{getDisplayValue()}</span>
                    {clearable && value && !disabled && (
                        <XCircle
                            className="h-4 w-4 opacity-50 hover:opacity-100"
                            onClick={handleClear}
                        />
                    )}
                </Button>
            </PopoverTrigger>
            <PopoverContent
                className={cn('w-auto p-0', classNames?.content)}
                align={align}
                side={side}
            >
                <DateTimePicker
                    value={value}
                    onChange={onChange}
                    mode={mode}
                    {...dateTimePickerProps}
                />
            </PopoverContent>
        </Popover>
    );
}

