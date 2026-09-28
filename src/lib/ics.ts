export interface CalendarEntry {
  uid: string;
  title: string;
  startsAt: Date;
  endsAt: Date;
  location?: string | null;
  description?: string | null;
  url?: string | null;
  organizer?: { name: string; email: string } | null;
}

function stamp(date: Date): string {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function escapeText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Calendar lines may be at most 75 bytes long. Longer ones continue on the next line after a space. */
function fold(line: string): string {
  const parts: string[] = [];
  let current = '';
  let bytes = 0;
  for (const char of line) {
    const size = Buffer.byteLength(char);
    const limit = parts.length === 0 ? 75 : 74;
    if (bytes + size > limit) {
      parts.push(current);
      current = '';
      bytes = 0;
    }
    current += char;
    bytes += size;
  }
  parts.push(current);
  return parts.join('\r\n ');
}

/** A calendar file with a single appointment (RFC 5545). */
export function buildCalendarFile(entry: CalendarEntry, now = new Date()): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//event-backend//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${escapeText(entry.uid)}`,
    `DTSTAMP:${stamp(now)}`,
    `DTSTART:${stamp(entry.startsAt)}`,
    `DTEND:${stamp(entry.endsAt)}`,
    `SUMMARY:${escapeText(entry.title)}`,
    ...(entry.location ? [`LOCATION:${escapeText(entry.location)}`] : []),
    ...(entry.description ? [`DESCRIPTION:${escapeText(entry.description)}`] : []),
    ...(entry.url ? [`URL:${entry.url}`] : []),
    ...(entry.organizer
      ? [`ORGANIZER;CN=${escapeText(entry.organizer.name).replace(/[":]/g, '')}:mailto:${entry.organizer.email}`]
      : []),
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return `${lines.map(fold).join('\r\n')}\r\n`;
}
