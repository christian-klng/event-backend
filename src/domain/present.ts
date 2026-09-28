import { renderMarkdown } from '../lib/markdown.ts';
import { seatsAvailable } from './events.ts';
import type { EventRecord, TicketType } from './events.ts';

export interface PresentOptions {
  baseUrl: string;
  lowStockThreshold: number;
  now?: Date;
}

function thumbnail(event: EventRecord, baseUrl: string) {
  if (!event.thumbnail_hash) return null;
  return {
    large: `${baseUrl}/media/${event.thumbnail_hash}/large.webp`,
    small: `${baseUrl}/media/${event.thumbnail_hash}/small.webp`,
    width: event.thumbnail_width,
    height: event.thumbnail_height,
  };
}

function isInSalesWindow(event: EventRecord, ticket: TicketType, now: Date): boolean {
  const end = ticket.sales_end ?? event.starts_at;
  if (ticket.sales_start && now < ticket.sales_start) return false;
  return now < end;
}

function publicTicket(event: EventRecord, ticket: TicketType, options: PresentOptions, now: Date) {
  const available = seatsAvailable(ticket);
  const soldOut = available === 0;
  return {
    id: ticket.id,
    name: ticket.name,
    description: ticket.description,
    attendance: ticket.attendance,
    price_cents: ticket.price_cents,
    currency: ticket.currency,
    max_per_order:
      available === null ? ticket.max_per_order : Math.min(ticket.max_per_order, available),
    sales_start: ticket.sales_start,
    sales_end: ticket.sales_end ?? event.starts_at,
    on_sale: event.status === 'published' && !soldOut && isInSalesWindow(event, ticket, now),
    sold_out: soldOut,
    /** Only set when few seats are left, so the website can show "only 3 left". */
    remaining: available !== null && available <= options.lowStockThreshold ? available : null,
  };
}

/** The event as the website sees it. Never contains the online URL or sales figures. */
export function toPublicEvent(event: EventRecord, options: PresentOptions, detail: boolean) {
  const now = options.now ?? new Date();
  const tickets = event.ticket_types.map((ticket) => publicTicket(event, ticket, options, now));
  const prices = tickets.map((ticket) => ticket.price_cents);
  return {
    id: event.id,
    slug: event.slug,
    status: event.status,
    title: event.title,
    summary: event.summary,
    ...(detail ? { description_html: renderMarkdown(event.description_md) } : {}),
    format: event.format,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    timezone: event.timezone,
    location:
      event.format !== 'online' && (event.location_name || event.location_address)
        ? { name: event.location_name, address: event.location_address }
        : null,
    thumbnail: thumbnail(event, options.baseUrl),
    price_from_cents: prices.length > 0 ? Math.min(...prices) : null,
    currency: tickets[0]?.currency ?? null,
    bookable: tickets.some((ticket) => ticket.on_sale),
    sold_out: tickets.length > 0 && tickets.every((ticket) => ticket.sold_out),
    tickets,
  };
}

/** The full event for administration, including the online URL and sales figures. */
export function toAdminEvent(event: EventRecord, baseUrl: string) {
  const { thumbnail_hash, thumbnail_width, thumbnail_height, ticket_types, ...rest } = event;
  return {
    ...rest,
    thumbnail: thumbnail(event, baseUrl),
    ticket_types: ticket_types.map((ticket) => ({
      ...ticket,
      available: seatsAvailable(ticket),
    })),
  };
}

export function toAdminEventSummary(event: EventRecord) {
  return {
    id: event.id,
    slug: event.slug,
    status: event.status,
    title: event.title,
    format: event.format,
    starts_at: event.starts_at,
    ends_at: event.ends_at,
    has_thumbnail: event.thumbnail_hash !== null,
    ticket_types: event.ticket_types.map((ticket) => ({
      id: ticket.id,
      name: ticket.name,
      attendance: ticket.attendance,
      price_cents: ticket.price_cents,
      capacity: ticket.capacity,
      sold: ticket.sold,
      reserved: ticket.reserved,
      available: seatsAvailable(ticket),
    })),
  };
}
