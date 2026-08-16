interface CalendarDate {
  readonly day: number;
  readonly month: number;
  readonly year: number;
}

function calendarDate(date: Date, timeZone?: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'numeric',
    ...(timeZone === undefined ? {} : { timeZone }),
    year: 'numeric',
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((candidate) => candidate.type === type)?.value);

  return { day: part('day'), month: part('month'), year: part('year') };
}

function serialDay(date: CalendarDate): number {
  return Date.UTC(date.year, date.month - 1, date.day) / 86_400_000;
}

export function formatConversationTimestamp(
  timestamp: string,
  now = new Date(),
  timeZone?: string,
): string | undefined {
  const messageDate = new Date(timestamp);
  if (Number.isNaN(messageDate.getTime()) || Number.isNaN(now.getTime())) return undefined;

  const messageCalendarDate = calendarDate(messageDate, timeZone);
  const currentCalendarDate = calendarDate(now, timeZone);
  const dayDifference = serialDay(currentCalendarDate) - serialDay(messageCalendarDate);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(messageDate);

  if (dayDifference === 0) return time;
  if (dayDifference === 1) return `Yesterday, ${time}`;

  const date = new Intl.DateTimeFormat('en-US', {
    day: 'numeric',
    month: 'short',
    ...(messageCalendarDate.year === currentCalendarDate.year ? {} : { year: 'numeric' }),
    ...(timeZone === undefined ? {} : { timeZone }),
  }).format(messageDate);
  return `${date}, ${time}`;
}
