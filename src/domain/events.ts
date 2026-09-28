import type { Db, Queryable } from '../db/index.ts';
import { DomainError } from '../lib/errors.ts';
import { SLUG_PATTERN, slugify } from '../lib/slug.ts';

export const EVENT_STATUSES = ['draft', 'published', 'cancelled', 'archived'] as const;
export const EVENT_FORMATS = ['online', 'onsite', 'hybrid'] as const;
export const ATTENDANCE_MODES = ['online', 'onsite'] as const;

export type EventStatus = (typeof EVENT_STATUSES)[number];
export type EventFormat = (typeof EVENT_FORMATS)[number];
export type Attendance = (typeof ATTENDANCE_MODES)[number];

export interface TicketType {
  id: string;
  event_id: string;
  name: string;
  description: string;
  attendance: Attendance;
  price_cents: number;
  currency: string;
  capacity: number | null;
  max_per_order: number;
  sales_start: Date | null;
  sales_end: Date | null;
  sort_order: number;
  /** Seats in paid orders. */
  sold: number;
  /** Seats held by checkouts that are still open. */
  reserved: number;
}

export interface EventRecord {
  id: string;
  slug: string;
  status: EventStatus;
  title: string;
  summary: string;
  description_md: string;
  format: EventFormat;
  starts_at: Date;
  ends_at: Date;
  timezone: string;
  location_name: string | null;
  location_address: string | null;
  online_url: string | null;
  thumbnail_hash: string | null;
  thumbnail_width: number | null;
  thumbnail_height: number | null;
  created_at: Date;
  updated_at: Date;
  ticket_types: TicketType[];
}

export interface TicketTypeInput {
  name: string;
  description?: string;
  attendance: Attendance;
  price_cents: number;
  currency?: string;
  capacity?: number | null;
  max_per_order?: number;
  sales_start?: Date | null;
  sales_end?: Date | null;
  sort_order?: number;
}

export interface EventInput {
  title: string;
  slug?: string;
  summary?: string;
  description_md?: string;
  format: EventFormat;
  starts_at: Date;
  ends_at: Date;
  timezone?: string;
  location_name?: string | null;
  location_address?: string | null;
  online_url?: string | null;
  ticket_types?: TicketTypeInput[];
}

export type EventPatch = Partial<Omit<EventInput, 'ticket_types'>>;
export type TicketTypePatch = Partial<TicketTypeInput>;

export interface EventFilter {
  statuses?: readonly EventStatus[];
  when?: 'upcoming' | 'past' | 'all';
}

export interface StatusChange {
  event: EventRecord;
  warnings: string[];
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const EVENT_SELECT = `
  select e.id, e.slug, e.status, e.title, e.summary, e.description_md, e.format,
         e.starts_at, e.ends_at, e.timezone, e.location_name, e.location_address,
         e.online_url, e.thumbnail_hash, i.width as thumbnail_width,
         i.height as thumbnail_height, e.created_at, e.updated_at
  from events e
  left join images i on i.hash = e.thumbnail_hash
`;

const TICKET_SELECT = `
  select t.id, t.event_id, t.name, t.description, t.attendance, t.price_cents, t.currency,
         t.capacity, t.max_per_order, t.sales_start, t.sales_end, t.sort_order,
         coalesce(sum(o.quantity) filter (where o.status = 'paid'), 0)::int as sold,
         coalesce(sum(o.quantity) filter (
           where o.status = 'pending' and o.expires_at > now()
         ), 0)::int as reserved
  from ticket_types t
  left join orders o on o.ticket_type_id = t.id
`;

const TICKET_GROUP = 'group by t.id order by t.sort_order, t.created_at, t.id';

const ALLOWED_TRANSITIONS: Record<EventStatus, readonly EventStatus[]> = {
  draft: ['published', 'archived'],
  published: ['draft', 'cancelled', 'archived'],
  cancelled: ['archived'],
  archived: ['draft'],
};

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Seats that can still be sold, or null when the ticket type has no limit. */
export function seatsAvailable(ticket: TicketType): number | null {
  if (ticket.capacity === null) return null;
  return Math.max(0, ticket.capacity - ticket.sold - ticket.reserved);
}

export async function listEvents(db: Queryable, filter: EventFilter = {}): Promise<EventRecord[]> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filter.statuses && filter.statuses.length > 0) {
    const placeholders = filter.statuses.map((status) => {
      params.push(status);
      return `$${params.length}`;
    });
    conditions.push(`e.status in (${placeholders.join(', ')})`);
  }
  const when = filter.when ?? 'all';
  if (when === 'upcoming') conditions.push('e.ends_at >= now()');
  if (when === 'past') conditions.push('e.ends_at < now()');

  const where = conditions.length > 0 ? `where ${conditions.join(' and ')}` : '';
  const order = when === 'past' ? 'e.starts_at desc' : 'e.starts_at asc';

  const events = await db.query<Omit<EventRecord, 'ticket_types'>>(
    `${EVENT_SELECT} ${where} order by ${order}, e.id`,
    params,
  );
  const tickets = await db.query<TicketType>(
    `${TICKET_SELECT}
     where t.event_id in (select e.id from events e ${where})
     ${TICKET_GROUP}`,
    params,
  );

  const byEvent = new Map<string, TicketType[]>();
  for (const ticket of tickets) {
    const list = byEvent.get(ticket.event_id) ?? [];
    list.push(ticket);
    byEvent.set(ticket.event_id, list);
  }
  return events.map((event) => ({ ...event, ticket_types: byEvent.get(event.id) ?? [] }));
}

export async function findEvent(db: Queryable, idOrSlug: string): Promise<EventRecord | null> {
  const column = isUuid(idOrSlug) ? 'e.id' : 'e.slug';
  const [event] = await db.query<Omit<EventRecord, 'ticket_types'>>(
    `${EVENT_SELECT} where ${column} = $1`,
    [idOrSlug],
  );
  if (!event) return null;
  const ticket_types = await db.query<TicketType>(
    `${TICKET_SELECT} where t.event_id = $1 ${TICKET_GROUP}`,
    [event.id],
  );
  return { ...event, ticket_types };
}

export async function getEvent(db: Queryable, idOrSlug: string): Promise<EventRecord> {
  const event = await findEvent(db, idOrSlug);
  if (!event) throw new DomainError('not_found', `No event found for "${idOrSlug}".`);
  return event;
}

export async function createEvent(db: Db, input: EventInput): Promise<EventRecord> {
  validateEventFields(input);
  assertTimeRange(input.starts_at, input.ends_at);
  for (const ticket of input.ticket_types ?? []) {
    validateTicketFields(ticket);
    assertAttendanceFits(input.format, ticket.attendance);
  }

  const id = await db.tx(async (tx) => {
    const slug = await resolveSlug(tx, input.slug, input.title);
    const [row] = await tx.query<{ id: string }>(
      `insert into events (slug, title, summary, description_md, format, starts_at, ends_at,
                           timezone, location_name, location_address, online_url)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning id`,
      [
        slug,
        input.title.trim(),
        input.summary ?? '',
        input.description_md ?? '',
        input.format,
        input.starts_at,
        input.ends_at,
        input.timezone ?? 'Europe/Berlin',
        input.location_name ?? null,
        input.location_address ?? null,
        input.online_url ?? null,
      ],
    );
    if (!row) throw new Error('insert returned no row');
    for (const [index, ticket] of (input.ticket_types ?? []).entries()) {
      await insertTicketType(tx, row.id, { sort_order: index, ...ticket });
    }
    return row.id;
  });
  return getEvent(db, id);
}

export async function updateEvent(db: Db, idOrSlug: string, patch: EventPatch): Promise<EventRecord> {
  validateEventFields(patch);

  const id = await db.tx(async (tx) => {
    const current = await getEvent(tx, idOrSlug);
    assertTimeRange(patch.starts_at ?? current.starts_at, patch.ends_at ?? current.ends_at);
    if (patch.format) {
      for (const ticket of current.ticket_types) {
        assertAttendanceFits(patch.format, ticket.attendance, ticket.name);
      }
    }

    const values: Record<string, unknown> = {};
    if (patch.slug !== undefined && patch.slug !== current.slug) {
      values.slug = await resolveSlug(tx, patch.slug, current.title);
    }
    if (patch.title !== undefined) values.title = patch.title.trim();
    for (const key of [
      'summary',
      'description_md',
      'format',
      'starts_at',
      'ends_at',
      'timezone',
      'location_name',
      'location_address',
      'online_url',
    ] as const) {
      if (patch[key] !== undefined) values[key] = patch[key];
    }
    await updateRow(tx, 'events', current.id, values, true);
    return current.id;
  });
  return getEvent(db, id);
}

export async function setEventStatus(
  db: Db,
  idOrSlug: string,
  status: EventStatus,
): Promise<StatusChange> {
  const warnings: string[] = [];

  const id = await db.tx(async (tx) => {
    const event = await getEvent(tx, idOrSlug);
    if (event.status === status) return event.id;
    if (!ALLOWED_TRANSITIONS[event.status].includes(status)) {
      throw new DomainError(
        'conflict',
        `An event with status "${event.status}" cannot change to "${status}". ` +
          `Allowed: ${ALLOWED_TRANSITIONS[event.status].join(', ')}.`,
      );
    }

    const sold = event.ticket_types.reduce((sum, ticket) => sum + ticket.sold, 0);
    if (status === 'published') {
      if (event.ticket_types.length === 0) {
        throw new DomainError('invalid', 'Add at least one ticket type before publishing.');
      }
      if (event.ends_at.getTime() <= Date.now()) {
        throw new DomainError('invalid', 'The event has already ended and cannot be published.');
      }
      if (event.format !== 'onsite' && !event.online_url) {
        warnings.push('No online URL is set yet. Buyers of online tickets cannot receive an access link.');
      }
      if (event.format !== 'online' && !event.location_name && !event.location_address) {
        warnings.push('No location is set for the on-site part.');
      }
      if (!event.thumbnail_hash) warnings.push('The event has no thumbnail.');
      if (!event.description_md.trim()) warnings.push('The event has no description.');
    }
    if (status === 'draft' && sold > 0) {
      warnings.push(`${sold} tickets are already sold. The event is now hidden from the website.`);
    }
    if (status === 'cancelled' && sold > 0) {
      warnings.push(`${sold} tickets are already sold. Buyers are not notified or refunded automatically.`);
    }

    await updateRow(tx, 'events', event.id, { status }, true);
    return event.id;
  });
  return { event: await getEvent(db, id), warnings };
}

export async function duplicateEvent(
  db: Db,
  idOrSlug: string,
  overrides: { title?: string; slug?: string; starts_at: Date; ends_at: Date },
): Promise<EventRecord> {
  const source = await getEvent(db, idOrSlug);
  const copy = await createEvent(db, {
    title: overrides.title ?? source.title,
    slug: overrides.slug,
    summary: source.summary,
    description_md: source.description_md,
    format: source.format,
    starts_at: overrides.starts_at,
    ends_at: overrides.ends_at,
    timezone: source.timezone,
    location_name: source.location_name,
    location_address: source.location_address,
    online_url: source.online_url,
    // Sales windows belong to the original dates and are not carried over.
    ticket_types: source.ticket_types.map((ticket) => ({
      name: ticket.name,
      description: ticket.description,
      attendance: ticket.attendance,
      price_cents: ticket.price_cents,
      currency: ticket.currency,
      capacity: ticket.capacity,
      max_per_order: ticket.max_per_order,
      sort_order: ticket.sort_order,
    })),
  });
  if (source.thumbnail_hash) {
    await db.query('update events set thumbnail_hash = $1 where id = $2', [
      source.thumbnail_hash,
      copy.id,
    ]);
  }
  return getEvent(db, copy.id);
}

export async function deleteEvent(db: Db, idOrSlug: string): Promise<EventRecord> {
  return db.tx(async (tx) => {
    const event = await getEvent(tx, idOrSlug);
    if (event.status !== 'draft') {
      throw new DomainError('conflict', 'Only drafts can be deleted. Archive the event instead.');
    }
    const [orders] = await tx.query<{ count: number }>(
      'select count(*)::int as count from orders where event_id = $1',
      [event.id],
    );
    if ((orders?.count ?? 0) > 0) {
      throw new DomainError('conflict', 'The event has orders and cannot be deleted. Archive it instead.');
    }
    await tx.query('delete from events where id = $1', [event.id]);
    return event;
  });
}

export async function addTicketType(
  db: Db,
  idOrSlug: string,
  input: TicketTypeInput,
): Promise<EventRecord> {
  validateTicketFields(input);
  const id = await db.tx(async (tx) => {
    const event = await getEvent(tx, idOrSlug);
    assertAttendanceFits(event.format, input.attendance);
    await insertTicketType(tx, event.id, { sort_order: event.ticket_types.length, ...input });
    return event.id;
  });
  return getEvent(db, id);
}

export async function updateTicketType(
  db: Db,
  ticketTypeId: string,
  patch: TicketTypePatch,
): Promise<EventRecord> {
  validateTicketFields(patch);
  const id = await db.tx(async (tx) => {
    const { event, ticket } = await getTicketType(tx, ticketTypeId);
    if (patch.attendance) assertAttendanceFits(event.format, patch.attendance);
    assertSalesWindow(
      patch.sales_start === undefined ? ticket.sales_start : patch.sales_start,
      patch.sales_end === undefined ? ticket.sales_end : patch.sales_end,
    );

    const taken = ticket.sold + ticket.reserved;
    if (patch.capacity !== undefined && patch.capacity !== null && patch.capacity < taken) {
      throw new DomainError(
        'conflict',
        `The capacity cannot be lower than the ${taken} seats already sold or reserved.`,
      );
    }
    if (taken > 0 && patch.currency !== undefined && patch.currency !== ticket.currency) {
      throw new DomainError('conflict', 'The currency cannot change after tickets were sold.');
    }

    const values: Record<string, unknown> = {};
    for (const key of [
      'name',
      'description',
      'attendance',
      'price_cents',
      'currency',
      'capacity',
      'max_per_order',
      'sales_start',
      'sales_end',
      'sort_order',
    ] as const) {
      if (patch[key] !== undefined) values[key] = patch[key];
    }
    await updateRow(tx, 'ticket_types', ticket.id, values, false);
    return event.id;
  });
  return getEvent(db, id);
}

export async function removeTicketType(db: Db, ticketTypeId: string): Promise<EventRecord> {
  const id = await db.tx(async (tx) => {
    const { event, ticket } = await getTicketType(tx, ticketTypeId);
    const [orders] = await tx.query<{ count: number }>(
      'select count(*)::int as count from orders where ticket_type_id = $1',
      [ticket.id],
    );
    if ((orders?.count ?? 0) > 0) {
      throw new DomainError(
        'conflict',
        'The ticket type has orders and cannot be removed. Set its capacity to the sold amount to stop sales.',
      );
    }
    if (event.status === 'published' && event.ticket_types.length === 1) {
      throw new DomainError('conflict', 'A published event needs at least one ticket type.');
    }
    await tx.query('delete from ticket_types where id = $1', [ticket.id]);
    return event.id;
  });
  return getEvent(db, id);
}

async function getTicketType(
  db: Queryable,
  ticketTypeId: string,
): Promise<{ event: EventRecord; ticket: TicketType }> {
  const notFound = new DomainError('not_found', `No ticket type found for "${ticketTypeId}".`);
  if (!isUuid(ticketTypeId)) throw notFound;
  const [row] = await db.query<{ event_id: string }>(
    'select event_id from ticket_types where id = $1',
    [ticketTypeId],
  );
  if (!row) throw notFound;
  const event = await getEvent(db, row.event_id);
  const ticket = event.ticket_types.find((candidate) => candidate.id === ticketTypeId);
  if (!ticket) throw notFound;
  return { event, ticket };
}

async function insertTicketType(
  db: Queryable,
  eventId: string,
  input: TicketTypeInput,
): Promise<void> {
  assertSalesWindow(input.sales_start ?? null, input.sales_end ?? null);
  await db.query(
    `insert into ticket_types (event_id, name, description, attendance, price_cents, currency,
                               capacity, max_per_order, sales_start, sales_end, sort_order)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
    [
      eventId,
      input.name.trim(),
      input.description ?? '',
      input.attendance,
      input.price_cents,
      (input.currency ?? 'eur').toLowerCase(),
      input.capacity ?? null,
      input.max_per_order ?? 10,
      input.sales_start ?? null,
      input.sales_end ?? null,
      input.sort_order ?? 0,
    ],
  );
}

/** Column names come from fixed lists in this module, never from callers. */
async function updateRow(
  db: Queryable,
  table: 'events' | 'ticket_types',
  id: string,
  values: Record<string, unknown>,
  touch: boolean,
): Promise<void> {
  const columns = Object.keys(values);
  if (columns.length === 0) return;
  const assignments = columns.map((column, index) => `${column} = $${index + 2}`);
  if (touch) assignments.push('updated_at = now()');
  await db.query(`update ${table} set ${assignments.join(', ')} where id = $1`, [
    id,
    ...columns.map((column) => values[column]),
  ]);
}

async function resolveSlug(db: Queryable, requested: string | undefined, title: string): Promise<string> {
  if (requested !== undefined) {
    if (!SLUG_PATTERN.test(requested) || requested.length > 80) {
      throw new DomainError(
        'invalid',
        'A slug may only contain lowercase letters, digits and single hyphens (max. 80 characters).',
      );
    }
    if (isUuid(requested)) throw new DomainError('invalid', 'A slug must not look like an ID.');
    const taken = await db.query('select 1 from events where slug = $1', [requested]);
    if (taken.length > 0) throw new DomainError('conflict', `The slug "${requested}" is already in use.`);
    return requested;
  }

  const base = slugify(title);
  const rows = await db.query<{ slug: string }>('select slug from events where slug like $1', [
    `${base}%`,
  ]);
  const taken = new Set(rows.map((row) => row.slug));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function validateEventFields(input: EventPatch): void {
  if (input.title !== undefined && !input.title.trim()) {
    throw new DomainError('invalid', 'The title must not be empty.');
  }
  if (input.timezone !== undefined && !isTimeZone(input.timezone)) {
    throw new DomainError('invalid', `"${input.timezone}" is not a known time zone.`);
  }
  if (input.online_url) {
    let protocol = '';
    try {
      protocol = new URL(input.online_url).protocol;
    } catch {
      // handled below
    }
    if (protocol !== 'https:' && protocol !== 'http:') {
      throw new DomainError('invalid', 'The online URL must be a valid http(s) URL.');
    }
  }
}

function validateTicketFields(input: TicketTypePatch): void {
  if (input.name !== undefined && !input.name.trim()) {
    throw new DomainError('invalid', 'The ticket name must not be empty.');
  }
  if (input.price_cents !== undefined && (!Number.isInteger(input.price_cents) || input.price_cents < 0)) {
    throw new DomainError('invalid', 'The price must be a whole number of cents, zero or more.');
  }
  if (input.capacity != null && (!Number.isInteger(input.capacity) || input.capacity < 0)) {
    throw new DomainError('invalid', 'The capacity must be a whole number, zero or more.');
  }
  if (
    input.max_per_order !== undefined &&
    (!Number.isInteger(input.max_per_order) || input.max_per_order < 1 || input.max_per_order > 50)
  ) {
    throw new DomainError('invalid', 'The maximum per order must be between 1 and 50.');
  }
  if (input.currency !== undefined && !/^[a-z]{3}$/i.test(input.currency)) {
    throw new DomainError('invalid', 'The currency must be a three-letter code such as "eur".');
  }
}

function assertTimeRange(startsAt: Date, endsAt: Date): void {
  if (endsAt.getTime() <= startsAt.getTime()) {
    throw new DomainError('invalid', 'The event must end after it starts.');
  }
}

function assertSalesWindow(start: Date | null, end: Date | null): void {
  if (start && end && end.getTime() <= start.getTime()) {
    throw new DomainError('invalid', 'Ticket sales must end after they start.');
  }
}

function assertAttendanceFits(format: EventFormat, attendance: Attendance, name?: string): void {
  if (format === 'hybrid' || format === attendance) return;
  const subject = name ? `The ticket type "${name}"` : 'A ticket type';
  throw new DomainError(
    'invalid',
    `${subject} with attendance "${attendance}" does not fit an event with format "${format}".`,
  );
}

function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}
