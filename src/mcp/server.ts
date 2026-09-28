import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import {
  addTicketType,
  ATTENDANCE_MODES,
  createEvent,
  deleteEvent,
  duplicateEvent,
  EVENT_FORMATS,
  EVENT_STATUSES,
  getEvent,
  listEvents,
  removeTicketType,
  setEventStatus,
  updateEvent,
  updateTicketType,
} from '../domain/events.ts';
import {
  createUploadToken,
  MAX_UPLOAD_BYTES,
  removeEventThumbnail,
  setEventThumbnail,
} from '../domain/images.ts';
import { sendMail } from '../domain/mail.ts';
import { toAdminEvent, toAdminEventSummary } from '../domain/present.ts';
import {
  describeMailSettings,
  getGeneralSettings,
  getMailSettings,
  resolveMailPassword,
  updateGeneralSettings,
  updateMailSettings,
} from '../domain/settings.ts';
import { DomainError } from '../lib/errors.ts';
import { downloadPublicFile } from '../lib/safe-fetch.ts';

const INSTRUCTIONS = `
Manages seminars and workshops that are sold on the organizer's website.

- New events start as "draft" and are invisible on the website until set_event_status publishes them.
- Times are ISO 8601 with a UTC offset, for example 2026-11-05T09:00:00+01:00.
- Prices are gross amounts in cents: 49000 means 490.00.
- An event has a format (online, onsite, hybrid) and one or more ticket types. Each ticket type has
  its own price and seat capacity. Hybrid events need separate ticket types for online and onsite.
- The online URL is secret. It is only sent to buyers and never appears on the website.
- Thumbnails: use set_event_thumbnail_from_url for pictures on the web. For a local file, call
  create_thumbnail_upload and upload the file with the returned curl command.
`.trim();

const eventRef = z.string().min(1).describe('Event ID or slug');
const dateTime = z.iso
  .datetime({ offset: true })
  .describe('ISO 8601 with UTC offset, e.g. 2026-11-05T09:00:00+01:00');
const optionalText = z.string().nullable().optional();

const ticketTypeShape = {
  name: z.string().min(1).max(120).describe('Shown to buyers, e.g. "Präsenz" or "Online-Teilnahme"'),
  description: z.string().max(500).optional(),
  attendance: z.enum(ATTENDANCE_MODES).describe('How holders of this ticket take part'),
  price_cents: z.number().int().min(0).describe('Gross price in cents, e.g. 49000 for 490.00'),
  currency: z.string().length(3).optional().describe('Defaults to eur'),
  capacity: z.number().int().min(0).nullable().optional().describe('Number of seats. null = unlimited'),
  max_per_order: z.number().int().min(1).max(50).optional().describe('Defaults to 10'),
  sales_start: dateTime.nullable().optional().describe('Sales open immediately when omitted'),
  sales_end: dateTime.nullable().optional().describe('Sales end at the event start when omitted'),
  sort_order: z.number().int().optional(),
};

const eventShape = {
  title: z.string().min(1).max(200),
  slug: z.string().optional().describe('URL name. Derived from the title when omitted'),
  summary: z.string().max(500).optional().describe('One or two sentences for the event list'),
  description_md: z.string().max(20_000).optional().describe('Full description in Markdown'),
  format: z.enum(EVENT_FORMATS),
  starts_at: dateTime,
  ends_at: dateTime,
  timezone: z.string().optional().describe('IANA name. Defaults to Europe/Berlin'),
  location_name: optionalText.describe('Venue name, for onsite and hybrid events'),
  location_address: optionalText.describe('Venue address, for onsite and hybrid events'),
  online_url: optionalText.describe('Access link for online and hybrid events. Kept secret'),
};

type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
};

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    const result = await fn();
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (err) {
    if (err instanceof DomainError) {
      return { isError: true, content: [{ type: 'text', text: `${err.code}: ${err.message}` }] };
    }
    console.error('tool call failed', err);
    return { isError: true, content: [{ type: 'text', text: 'internal: unexpected server error' }] };
  }
}

function toDate(value: string): Date;
function toDate(value: string | undefined): Date | undefined;
function toDate(value: string | null | undefined): Date | null | undefined;
function toDate(value: string | null | undefined): Date | null | undefined {
  return typeof value === 'string' ? new Date(value) : value;
}

function ticketDates<T extends { sales_start?: string | null | undefined; sales_end?: string | null | undefined }>(
  input: T,
) {
  return { ...input, sales_start: toDate(input.sales_start), sales_end: toDate(input.sales_end) };
}

/** Drops keys that were not sent, so partial updates leave other fields alone. */
function sent<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as { [K in keyof T]?: Exclude<T[K], undefined> };
}

export function buildMcpServer(ctx: AppContext): McpServer {
  const { db, config } = ctx;
  const baseUrl = config.publicBaseUrl;
  const server = new McpServer(
    { name: 'event-backend', version: '0.1.0' },
    { instructions: INSTRUCTIONS },
  );

  // Events

  server.registerTool(
    'list_events',
    {
      title: 'List events',
      description: 'Lists events with their ticket types and sales figures.',
      inputSchema: {
        status: z.enum(EVENT_STATUSES).optional().describe('Only events with this status'),
        when: z.enum(['upcoming', 'past', 'all']).optional().describe('Defaults to all'),
      },
      annotations: { readOnlyHint: true },
    },
    ({ status, when }) =>
      run(async () => {
        const events = await listEvents(db, {
          ...(status ? { statuses: [status] } : {}),
          when: when ?? 'all',
        });
        return { events: events.map(toAdminEventSummary) };
      }),
  );

  server.registerTool(
    'get_event',
    {
      title: 'Get event',
      description: 'Returns one event with all fields, including the online URL and sales figures.',
      inputSchema: { event: eventRef },
      annotations: { readOnlyHint: true },
    },
    ({ event }) => run(async () => toAdminEvent(await getEvent(db, event), baseUrl)),
  );

  server.registerTool(
    'create_event',
    {
      title: 'Create event',
      description:
        'Creates an event as a draft. Ticket types can be passed along or added later with add_ticket_type.',
      inputSchema: {
        ...eventShape,
        ticket_types: z.array(z.object(ticketTypeShape)).max(20).optional(),
      },
    },
    (input) =>
      run(async () => {
        const event = await createEvent(db, {
          ...sent(input),
          title: input.title,
          format: input.format,
          starts_at: toDate(input.starts_at),
          ends_at: toDate(input.ends_at),
          ticket_types: (input.ticket_types ?? []).map((ticket) => ({
            ...sent(ticketDates(ticket)),
            name: ticket.name,
            attendance: ticket.attendance,
            price_cents: ticket.price_cents,
          })),
        });
        return toAdminEvent(event, baseUrl);
      }),
  );

  server.registerTool(
    'update_event',
    {
      title: 'Update event',
      description:
        'Changes fields of an event. Only the fields that are passed change. Pass null to clear a location or the online URL.',
      inputSchema: {
        event: eventRef,
        ...Object.fromEntries(
          Object.entries(eventShape).map(([key, schema]) => [key, schema.optional()]),
        ) as { [K in keyof typeof eventShape]: z.ZodOptional<(typeof eventShape)[K]> },
      },
    },
    ({ event, starts_at, ends_at, ...fields }) =>
      run(async () => {
        const updated = await updateEvent(
          db,
          event,
          sent({ ...fields, starts_at: toDate(starts_at), ends_at: toDate(ends_at) }),
        );
        return toAdminEvent(updated, baseUrl);
      }),
  );

  server.registerTool(
    'set_event_status',
    {
      title: 'Set event status',
      description:
        'Publishes, unpublishes, cancels or archives an event. "published" makes it visible on the website and opens ticket sales. "draft" hides it again. "cancelled" stops sales and shows the event as cancelled.',
      inputSchema: { event: eventRef, status: z.enum(EVENT_STATUSES) },
    },
    ({ event, status }) =>
      run(async () => {
        const result = await setEventStatus(db, event, status);
        return { warnings: result.warnings, event: toAdminEvent(result.event, baseUrl) };
      }),
  );

  server.registerTool(
    'duplicate_event',
    {
      title: 'Duplicate event',
      description:
        'Copies an event with its ticket types and thumbnail into a new draft with new dates. Sales windows of ticket types are not copied.',
      inputSchema: {
        event: eventRef,
        title: z.string().min(1).max(200).optional(),
        slug: z.string().optional(),
        starts_at: dateTime,
        ends_at: dateTime,
      },
    },
    ({ event, starts_at, ends_at, ...rest }) =>
      run(async () => {
        const copy = await duplicateEvent(db, event, {
          ...sent(rest),
          starts_at: toDate(starts_at),
          ends_at: toDate(ends_at),
        });
        return toAdminEvent(copy, baseUrl);
      }),
  );

  server.registerTool(
    'delete_event',
    {
      title: 'Delete event',
      description:
        'Permanently deletes a draft that has no orders. Events that were on sale can only be archived.',
      inputSchema: { event: eventRef },
      annotations: { destructiveHint: true },
    },
    ({ event }) =>
      run(async () => {
        const deleted = await deleteEvent(db, event);
        return { deleted: { id: deleted.id, slug: deleted.slug, title: deleted.title } };
      }),
  );

  // Ticket types

  server.registerTool(
    'add_ticket_type',
    {
      title: 'Add ticket type',
      description: 'Adds a ticket type with its own price and seat capacity to an event.',
      inputSchema: { event: eventRef, ...ticketTypeShape },
    },
    ({ event, ...ticket }) =>
      run(async () => {
        const updated = await addTicketType(db, event, {
          ...sent(ticketDates(ticket)),
          name: ticket.name,
          attendance: ticket.attendance,
          price_cents: ticket.price_cents,
        });
        return toAdminEvent(updated, baseUrl);
      }),
  );

  server.registerTool(
    'update_ticket_type',
    {
      title: 'Update ticket type',
      description:
        'Changes a ticket type. Only the fields that are passed change. The capacity cannot go below the seats already sold.',
      inputSchema: {
        ticket_type_id: z.string().min(1),
        ...Object.fromEntries(
          Object.entries(ticketTypeShape).map(([key, schema]) => [key, schema.optional()]),
        ) as { [K in keyof typeof ticketTypeShape]: z.ZodOptional<(typeof ticketTypeShape)[K]> },
      },
    },
    ({ ticket_type_id, sales_start, sales_end, ...patch }) =>
      run(async () => {
        const updated = await updateTicketType(
          db,
          ticket_type_id,
          sent({ ...patch, sales_start: toDate(sales_start), sales_end: toDate(sales_end) }),
        );
        return toAdminEvent(updated, baseUrl);
      }),
  );

  server.registerTool(
    'remove_ticket_type',
    {
      title: 'Remove ticket type',
      description: 'Removes a ticket type that has no orders.',
      inputSchema: { ticket_type_id: z.string().min(1) },
      annotations: { destructiveHint: true },
    },
    ({ ticket_type_id }) =>
      run(async () => toAdminEvent(await removeTicketType(db, ticket_type_id), baseUrl)),
  );

  // Thumbnails

  server.registerTool(
    'set_event_thumbnail_from_url',
    {
      title: 'Set thumbnail from URL',
      description:
        'Downloads a picture from a public URL and uses it as the event thumbnail. The picture is converted to WebP in two sizes.',
      inputSchema: { event: eventRef, url: z.url() },
      annotations: { openWorldHint: true },
    },
    ({ event, url }) =>
      run(async () => {
        await getEvent(db, event);
        const file = await (ctx.download ?? downloadPublicFile)(url, { maxBytes: MAX_UPLOAD_BYTES });
        return toAdminEvent(await setEventThumbnail(db, event, file), baseUrl);
      }),
  );

  server.registerTool(
    'create_thumbnail_upload',
    {
      title: 'Create thumbnail upload link',
      description:
        'Returns a single-use link for uploading a local picture as the event thumbnail. Upload the file with an HTTP PUT, for example with the returned curl command. The link is valid for 15 minutes.',
      inputSchema: { event: eventRef },
    },
    ({ event }) =>
      run(async () => {
        const ticket = await createUploadToken(db, event);
        const uploadUrl = `${baseUrl}/uploads/${ticket.token}`;
        return {
          upload_url: uploadUrl,
          method: 'PUT',
          expires_at: ticket.expires_at,
          max_bytes: MAX_UPLOAD_BYTES,
          curl: `curl --fail-with-body -T "/path/to/image.jpg" "${uploadUrl}"`,
        };
      }),
  );

  server.registerTool(
    'remove_event_thumbnail',
    {
      title: 'Remove thumbnail',
      description: 'Removes the thumbnail from an event.',
      inputSchema: { event: eventRef },
    },
    ({ event }) => run(async () => toAdminEvent(await removeEventThumbnail(db, event), baseUrl)),
  );

  // Settings

  server.registerTool(
    'get_settings',
    {
      title: 'Get settings',
      description: 'Returns the general settings and the mail settings. The SMTP password is never returned.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () => ({
        general: await getGeneralSettings(db),
        mail: describeMailSettings(await getMailSettings(db), config),
        public_base_url: baseUrl,
      })),
  );

  server.registerTool(
    'update_settings',
    {
      title: 'Update general settings',
      description: 'Changes general settings. Only the fields that are passed change.',
      inputSchema: {
        organizer_name: z.string().max(200).optional(),
        website_url: z.url().nullable().optional(),
        allowed_origins: z
          .array(z.string())
          .optional()
          .describe(
            'Websites that may call the public API from a browser, e.g. ["https://www.example.com"]. Empty list = any website',
          ),
        checkout_success_url: z.url().nullable().optional().describe('Page shown after a successful payment'),
        checkout_cancel_url: z.url().nullable().optional().describe('Page shown when a buyer aborts the payment'),
        terms_url: z.url().nullable().optional(),
        privacy_url: z.url().nullable().optional(),
        low_stock_threshold: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe('The website learns the number of free seats only at or below this value'),
      },
    },
    (patch) =>
      run(async () => {
        const general = await updateGeneralSettings(db, sent(patch));
        ctx.invalidateSettings();
        return { general };
      }),
  );

  server.registerTool(
    'update_mail_settings',
    {
      title: 'Update mail settings',
      description:
        'Configures the SMTP mailbox used for mails to buyers. Only the fields that are passed change. The password is stored encrypted and never returned. Verify the setup with send_test_email.',
      inputSchema: {
        host: z.string().nullable().optional().describe('SMTP server, e.g. smtp.example.com'),
        port: z.number().int().min(1).max(65535).optional().describe('587 for starttls, 465 for tls'),
        security: z.enum(['starttls', 'tls', 'none']).optional(),
        username: z.string().nullable().optional(),
        password: z.string().nullable().optional().describe('null removes the stored password'),
        from_name: z.string().max(200).optional(),
        from_email: z.email().nullable().optional(),
        reply_to: z.email().nullable().optional(),
      },
    },
    (patch) =>
      run(async () => {
        const mail = await updateMailSettings(db, sent(patch), config.appSecret);
        return { mail: describeMailSettings(mail, config) };
      }),
  );

  server.registerTool(
    'send_test_email',
    {
      title: 'Send test mail',
      description: 'Sends a test mail through the configured SMTP mailbox to check the mail settings.',
      inputSchema: { to: z.email() },
      annotations: { openWorldHint: true },
    },
    ({ to }) =>
      run(async () => {
        const [mail, general] = await Promise.all([getMailSettings(db), getGeneralSettings(db)]);
        const sender = general.organizer_name || 'event-backend';
        const result = await sendMail(
          mail,
          resolveMailPassword(mail, config),
          {
            to,
            subject: `Testnachricht von ${sender}`,
            text: 'Diese Nachricht bestätigt, dass der E-Mail-Versand für Ihre Veranstaltungen funktioniert.',
          },
          ctx.mailTransport,
        );
        return { sent: true, to, ...result };
      }),
  );

  return server;
}
