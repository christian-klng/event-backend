const LOCALE = 'de-DE';

function dayOf(date: Date, timeZone: string, withWeekday: boolean): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    ...(withWeekday ? { weekday: 'long' } : {}),
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(date);
}

function timeOf(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(date);
}

/** "Donnerstag, 5. November 2026, 09:00–17:00 Uhr", in the time zone of the event. */
export function formatEventTime(startsAt: Date, endsAt: Date, timeZone: string): string {
  const sameDay = dayOf(startsAt, timeZone, false) === dayOf(endsAt, timeZone, false);
  if (sameDay) {
    return `${dayOf(startsAt, timeZone, true)}, ${timeOf(startsAt, timeZone)}–${timeOf(endsAt, timeZone)} Uhr`;
  }
  return (
    `${dayOf(startsAt, timeZone, true)}, ${timeOf(startsAt, timeZone)} Uhr bis ` +
    `${dayOf(endsAt, timeZone, true)}, ${timeOf(endsAt, timeZone)} Uhr`
  );
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat(LOCALE, { style: 'currency', currency: currency.toUpperCase() }).format(
    cents / 100,
  );
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
