import type { ReactElement } from 'react';
import { Calendar, type ISODateString } from '@astryxdesign/core/Calendar';
import { Timestamp } from '@astryxdesign/core/Timestamp';
import { WEEK_STARTS_ON } from '@/features/productivity/use-today';

/** The month grid both calendars use (the Calendar page and a space's Agenda):
 *  one week start, one picker, so the two never disagree about a day. */
export function CalendarGrid({
  value,
  onChange,
  focusDate,
  onFocusDateChange,
}: {
  value: string;
  onChange: (day: string) => void;
  focusDate?: string;
  onFocusDateChange?: (focus: string) => void;
}): ReactElement {
  return (
    <Calendar
      mode="single"
      weekStartsOn={WEEK_STARTS_ON}
      value={value as ISODateString}
      onChange={(picked) => {
        if (picked !== undefined) onChange(picked);
      }}
      focusDate={focusDate as ISODateString | undefined}
      onFocusDateChange={onFocusDateChange}
    />
  );
}

/** A day key as a heading ("Mon, Sep 20, 2026"); the one day label for every
 *  calendar list. A day key is a calendar date, so no zone applies. */
export function DayLabel({ day }: { day: string }): ReactElement {
  if (day === 'unknown') return <>Unscheduled</>;
  return <Timestamp value={`${day}T00:00:00`} format="date_weekday" type="inherit" color="inherit" />;
}
