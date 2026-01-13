'use client'

import React, { type FC, useState, useEffect, useRef } from 'react'
import { Button } from './button'
import { Popover, PopoverContent, PopoverTrigger } from './ui/popover'
import { Calendar } from './ui/calendar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from './ui/select'
import { ChevronUpIcon, ChevronDownIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface DateRangePickerProps {
  /** Click handler for applying the updates from DateRangePicker. */
  onUpdate?: (values: { range: DateRange }) => void
  /** Initial value for start date */
  initialDateFrom?: Date | string
  /** Initial value for end date */
  initialDateTo?: Date | string
  /** Alignment of popover */
  align?: 'start' | 'center' | 'end'
  /** Option for locale */
  locale?: string
}

const formatDate = (date: Date, locale: string = 'en-us'): string => {
  return date.toLocaleDateString(locale, {
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  })
}

const getDateAdjustedForTimezone = (dateInput: Date | string): Date => {
  if (typeof dateInput === 'string') {
    // Split the date string to get year, month, and day parts
    const parts = dateInput.split('-').map((part) => parseInt(part, 10))
    // Create a new Date object using the local timezone
    // Note: Month is 0-indexed, so subtract 1 from the month part
    const date = new Date(parts[0], parts[1] - 1, parts[2])
    return date
  } else {
    // If dateInput is already a Date object, return it directly
    return dateInput
  }
}

interface DateRange {
  from: Date
  to: Date | undefined
}

interface Preset {
  name: string
  label: string
}

// Define presets
const PRESETS: Preset[] = [
  { name: 'today', label: 'Today' },
  { name: 'yesterday', label: 'Yesterday' },
  { name: 'last7', label: 'Last 7 days' },
  { name: 'last14', label: 'Last 14 days' },
  { name: 'last30', label: 'Last 30 days' },
  { name: 'thisWeek', label: 'This Week' },
  { name: 'lastWeek', label: 'Last Week' },
  { name: 'thisMonth', label: 'This Month' },
  { name: 'lastMonth', label: 'Last Month' }
]

/** The DateRangePicker component allows a user to select a range of dates */
export const DateRangePicker: FC<DateRangePickerProps> = ({
  initialDateFrom = new Date(new Date().setHours(0, 0, 0, 0)),
  initialDateTo,
  onUpdate,
  align = 'end',
  locale = 'en-US'
}): React.ReactNode => {
  const [isOpen, setIsOpen] = useState(false)

  const [range, setRange] = useState<DateRange>({
    from: getDateAdjustedForTimezone(initialDateFrom),
    to: initialDateTo
      ? getDateAdjustedForTimezone(initialDateTo)
      : getDateAdjustedForTimezone(initialDateFrom)
  })
  
  const [month, setMonth] = useState<Date>(getDateAdjustedForTimezone(initialDateFrom))

  // Ref to store the value of range when the date picker is opened
  const openedRangeRef = useRef<DateRange | undefined>(undefined)

  const [selectedPreset, setSelectedPreset] = useState<string | undefined>(undefined)

  const getPresetRange = (presetName: string): DateRange => {
    const preset = PRESETS.find(({ name }) => name === presetName)
    if (!preset) throw new Error(`Unknown date range preset: ${presetName}`)
    const from = new Date()
    const to = new Date()
    const first = from.getDate() - from.getDay()

    switch (preset.name) {
      case 'today':
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'yesterday':
        from.setDate(from.getDate() - 1)
        from.setHours(0, 0, 0, 0)
        to.setDate(to.getDate() - 1)
        to.setHours(23, 59, 59, 999)
        break
      case 'last7':
        from.setDate(from.getDate() - 6)
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'last14':
        from.setDate(from.getDate() - 13)
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'last30':
        from.setDate(from.getDate() - 29)
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'thisWeek':
        from.setDate(first)
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'lastWeek':
        from.setDate(from.getDate() - 7 - from.getDay())
        to.setDate(to.getDate() - to.getDay() - 1)
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'thisMonth':
        from.setDate(1)
        from.setHours(0, 0, 0, 0)
        to.setHours(23, 59, 59, 999)
        break
      case 'lastMonth':
        from.setMonth(from.getMonth() - 1)
        from.setDate(1)
        from.setHours(0, 0, 0, 0)
        to.setDate(0)
        to.setHours(23, 59, 59, 999)
        break
    }

    return { from, to }
  }

  const setPreset = (preset: string): void => {
    const range = getPresetRange(preset)
    setRange(range)
  }

  const checkPreset = (): void => {
    for (const preset of PRESETS) {
      const presetRange = getPresetRange(preset.name)

      const normalizedRangeFrom = new Date(range.from);
      normalizedRangeFrom.setHours(0, 0, 0, 0);
      const normalizedPresetFrom = new Date(
        presetRange.from.setHours(0, 0, 0, 0)
      )

      const normalizedRangeTo = new Date(range.to ?? 0);
      normalizedRangeTo.setHours(0, 0, 0, 0);
      const normalizedPresetTo = new Date(
        presetRange.to?.setHours(0, 0, 0, 0) ?? 0
      )

      if (
        normalizedRangeFrom.getTime() === normalizedPresetFrom.getTime() &&
        normalizedRangeTo.getTime() === normalizedPresetTo.getTime()
      ) {
        setSelectedPreset(preset.name)
        return
      }
    }

    setSelectedPreset(undefined)
  }

  const resetValues = (): void => {
    setRange({
      from:
        typeof initialDateFrom === 'string'
          ? getDateAdjustedForTimezone(initialDateFrom)
          : initialDateFrom,
      to: initialDateTo
        ? typeof initialDateTo === 'string'
          ? getDateAdjustedForTimezone(initialDateTo)
          : initialDateTo
        : typeof initialDateFrom === 'string'
          ? getDateAdjustedForTimezone(initialDateFrom)
          : initialDateFrom
    })
  }

  useEffect(() => {
    checkPreset()
  }, [range])

  const PresetButton = ({
    preset,
    label,
    isSelected
  }: {
    preset: string
    label: string
    isSelected: boolean
  }): React.ReactNode => (
    <Button
      className={cn(
        'justify-start w-full text-left font-normal',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
      variant="ghost"
      onClick={() => {
        setPreset(preset)
      }}
    >
      {label}
    </Button>
  )

  // Helper function to check if two date ranges are equal
  const areRangesEqual = (a?: DateRange, b?: DateRange): boolean => {
    if (!a || !b) return a === b
    return (
      a.from.getTime() === b.from.getTime() &&
      (!a.to || !b.to || a.to.getTime() === b.to.getTime())
    )
  }

  useEffect(() => {
    if (isOpen) {
      openedRangeRef.current = range
    }
  }, [isOpen])

  return (
    <Popover
      modal={true}
      open={isOpen}
      onOpenChange={(open: boolean) => {
        if (!open) {
          // Only reset if we have an incomplete range (from but no to)
          // If we have both dates, keep the selection
          if (range.from && !range.to) {
            resetValues()
          }
        }
        setIsOpen(open)
      }}
    >
      <PopoverTrigger asChild>
        <Button variant="unstyled" className="border-2 w-full justify-start">
          <div className="text-left flex-1">
            <div className="py-1">
              <div>{`${formatDate(range.from, locale)}${
                range.to != null ? ' - ' + formatDate(range.to, locale) : ''
              }`}</div>
            </div>
          </div>
          <div className="pl-1 opacity-60 -mr-2 scale-125">
            {isOpen ? (<ChevronUpIcon width={24} />) : (<ChevronDownIcon width={24} />)}
          </div>
        </Button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-auto p-0">
        <div className="flex">
          {/* Presets on the left */}
          <div className="flex flex-col gap-0.5 p-2 border-r min-w-[140px]">
            {PRESETS.map((preset) => (
              <PresetButton
                key={preset.name}
                preset={preset.name}
                label={preset.label}
                isSelected={selectedPreset === preset.name}
              />
            ))}
          </div>
          
          {/* Calendar on the right */}
          <div className="p-3">
            {/* Month/Year selector */}
            <div className="flex items-center justify-between mb-2 px-2">
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => {
                  const newMonth = new Date(month)
                  newMonth.setMonth(newMonth.getMonth() - 1)
                  setMonth(newMonth)
                }}
              >
                <ChevronUpIcon className="h-4 w-4 -rotate-90" />
              </Button>
              
              <Select
                value={`${month.getFullYear()}-${month.getMonth()}`}
                onValueChange={(value) => {
                  const [year, monthIndex] = value.split('-').map(Number)
                  const newDate = new Date(year, monthIndex, 1)
                  setMonth(newDate)
                }}
              >
                <SelectTrigger className="h-8 w-auto border-0 font-medium">
                  <SelectValue>
                    {month.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {Array.from({ length: 24 }, (_, i) => {
                    const date = new Date()
                    date.setMonth(date.getMonth() - 23 + i)
                    return date
                  })
                    .filter((date) => date <= new Date()) // Only show months up to current month
                    .map((date) => (
                      <SelectItem
                        key={`${date.getFullYear()}-${date.getMonth()}`}
                        value={`${date.getFullYear()}-${date.getMonth()}`}
                      >
                        {date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
              
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                disabled={month.getMonth() === new Date().getMonth() && month.getFullYear() === new Date().getFullYear()}
                onClick={() => {
                  const newMonth = new Date(month)
                  newMonth.setMonth(newMonth.getMonth() + 1)
                  setMonth(newMonth)
                }}
              >
                <ChevronDownIcon className="h-4 w-4 -rotate-90" />
              </Button>
            </div>
            
            <Calendar
              mode="range"
              onSelect={(value: { from?: Date, to?: Date } | undefined) => {
                if (value?.from != null) {                  
                  // If value only has 'from' (user clicked first date of new range)
                  if (!value.to) {
                    setRange({ from: value.from, to: undefined });
                  }
                  // If value has both from and to
                  else if (value.to) {
                    // If they're the same, it's a single date click - start new range
                    if (value.from.getTime() === value.to.getTime()) {
                      setRange({ from: value.from, to: undefined });
                    } 
                    // Different dates - complete range
                    else {
                      setRange({ from: value.from, to: value.to });
                      // Trigger update when BOTH dates are selected and different
                      if (!areRangesEqual({ from: value.from, to: value.to }, openedRangeRef.current)) {
                        onUpdate?.({ range: { from: value.from, to: value.to } });
                      }
                    }
                  }
                }
              }}
              selected={{ from: range.from, to: range.to }}
              numberOfMonths={1}
              month={month}
              onMonthChange={setMonth}
              disabled={{ after: new Date() }}
            />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

DateRangePicker.displayName = 'DateRangePicker'
