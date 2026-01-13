'use client'

import * as React from 'react'
import { DayPicker, type DateRange } from 'react-day-picker'

import { cn } from '@/lib/utils'
import { buttonVariants } from './button'

export type CalendarProps = React.ComponentProps<typeof DayPicker>

function Calendar ({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: CalendarProps): React.ReactNode {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn('p-0', className)}
      classNames={{
        months: 'flex flex-col sm:flex-row space-y-4 sm:space-x-4 sm:space-y-0',
        month: 'space-y-4',
        month_caption: 'hidden',
        caption: 'hidden',
        caption_label: 'hidden',
        nav: 'hidden',
        nav_button: 'hidden',
        nav_button_previous: 'hidden',
        nav_button_next: 'hidden',
        month_grid: 'w-full border-collapse space-y-1',
        weekdays: 'flex',
        weekday: 'text-muted-foreground w-8 font-normal text-xs',
        week: 'flex w-full mt-2',
        day: 'h-8 w-8 p-0 font-normal text-center relative',
        day_button: cn(
          buttonVariants({ variant: 'ghost' }),
          'h-full w-full'
        ),
        selected: 'bg-primary text-primary-foreground',
        day_selected: 'bg-primary text-primary-foreground hover:bg-primary',
        range_start: '!rounded-l-md !rounded-r-none',
        range_end: '!rounded-r-md !rounded-l-none',
        range_middle: '!bg-primary/20 !text-primary !rounded-none',
        day_today: 'bg-accent text-accent-foreground font-bold',
        day_outside: 'text-muted-foreground opacity-40',
        day_disabled: 'text-muted-foreground opacity-50',
        day_hidden: 'invisible',
        ...classNames
      }}
      {...props}
    />
  )
}
Calendar.displayName = 'Calendar'

export { Calendar }
