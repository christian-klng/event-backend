import type { AppContext } from '../context.ts';
import { DomainError } from '../lib/errors.ts';
import { escapeHtml, formatEventTime } from '../lib/format.ts';
import { buildCalendarFile } from '../lib/ics.ts';
import { getEvent } from './events.ts';
import type { EventRecord } from './events.ts';
import { sendMail } from './mail.ts';
import type { MailMessage } from './mail.ts';
import { getOrder } from './orders.ts';
import type { Order } from './orders.ts';
import { getGeneralSettings, getMailSettings, resolveMailPassword } from './settings.ts';
import type { GeneralSettings, MailSettings } from './settings.ts';

const MAX_ATTEMPTS = 6;
const RETRY_AFTER_MINUTES = 10;
const BATCH_SIZE = 20;

interface Section {
  heading: string;
  lines: string[];
  link?: string;
}

function paragraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** The mail a buyer receives after the payment, with access link or venue and a calendar file. */
export function buildConfirmation(
  order: Order,
  event: EventRecord,
  general: GeneralSettings,
  mail: MailSettings,
): MailMessage {
  if (!order.customer_email) throw new DomainError('invalid', 'The order has no e-mail address.');

  const when = formatEventTime(event.starts_at, event.ends_at, event.timezone);
  const venue = [event.location_name, event.location_address].filter(Boolean).join(', ');
  const online = order.attendance === 'online';
  const tickets = `${order.quantity} × ${order.ticket_name}`;

  const sections: Section[] = [
    { heading: 'Veranstaltung', lines: [event.title, when] },
    { heading: 'Ihre Buchung', lines: [tickets] },
  ];
  if (online) {
    sections.push(
      event.online_url
        ? {
            heading: 'Zugang',
            lines: ['Über diesen Link nehmen Sie teil. Bitte geben Sie ihn nicht weiter.'],
            link: event.online_url,
          }
        : {
            heading: 'Zugang',
            lines: ['Den Link zur Teilnahme erhalten Sie rechtzeitig vor dem Termin in einer weiteren E-Mail.'],
          },
    );
  } else if (venue) {
    sections.push({ heading: 'Ort', lines: [venue] });
  }

  const greeting = order.customer_name ? `Guten Tag ${order.customer_name},` : 'Guten Tag,';
  const intro = [
    'vielen Dank für Ihre Anmeldung. Ihre Zahlung ist eingegangen und Ihr Platz ist gebucht.',
    ...paragraphs(general.confirmation_intro),
  ];
  const outro = [
    ...(general.stripe_invoices
      ? ['Ihre Rechnung erhalten Sie in einer separaten E-Mail von unserem Zahlungsdienstleister Stripe.']
      : []),
    'Den Termin finden Sie als Kalenderdatei im Anhang.',
    ...paragraphs(general.confirmation_footer),
  ];
  const signature = general.organizer_name || mail.from_name;

  const text = [
    greeting,
    ...intro,
    ...sections.map((section) =>
      [`${section.heading}:`, ...section.lines, ...(section.link ? [section.link] : [])].join('\n'),
    ),
    ...outro,
    ...(signature ? [`Freundliche Grüße\n${signature}`] : []),
  ].join('\n\n');

  const html = [
    '<div style="font-family:Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#1a1a1a;max-width:600px">',
    `<p>${escapeHtml(greeting)}</p>`,
    ...intro.map((line) => `<p>${escapeHtml(line).replaceAll('\n', '<br>')}</p>`),
    ...sections.map(
      (section) =>
        `<p><strong>${escapeHtml(section.heading)}</strong><br>` +
        section.lines.map(escapeHtml).join('<br>') +
        (section.link
          ? `<br><a href="${escapeHtml(section.link)}">${escapeHtml(section.link)}</a>`
          : '') +
        '</p>',
    ),
    ...outro.map((line) => `<p>${escapeHtml(line).replaceAll('\n', '<br>')}</p>`),
    ...(signature ? [`<p>Freundliche Grüße<br>${escapeHtml(signature)}</p>`] : []),
    '</div>',
  ].join('\n');

  const calendar = buildCalendarFile({
    uid: `${order.id}@event-backend`,
    title: event.title,
    startsAt: event.starts_at,
    endsAt: event.ends_at,
    location: online ? 'Online' : venue || null,
    description: online && event.online_url ? `Teilnahme: ${event.online_url}` : tickets,
    url: online ? event.online_url : null,
    organizer: mail.from_email
      ? { name: signature || mail.from_email, email: mail.from_email }
      : null,
  });

  return {
    to: order.customer_email,
    subject: `Ihre Anmeldung: ${event.title}`,
    text,
    html,
    attachments: [
      { filename: 'termin.ics', content: calendar, contentType: 'text/calendar; charset=utf-8; method=PUBLISH' },
    ],
  };
}

async function sendConfirmation(ctx: AppContext, order: Order): Promise<void> {
  const [event, general, mail] = await Promise.all([
    getEvent(ctx.db, order.event_id),
    getGeneralSettings(ctx.db),
    getMailSettings(ctx.db),
  ]);
  await sendMail(
    mail,
    resolveMailPassword(mail, ctx.config),
    buildConfirmation(order, event, general, mail),
    ctx.mailTransport,
  );
}

async function attempt(ctx: AppContext, orderId: string): Promise<boolean> {
  try {
    await sendConfirmation(ctx, await getOrder(ctx.db, orderId));
    await ctx.db.query(
      'update orders set confirmation_sent_at = now(), confirmation_error = null where id = $1',
      [orderId],
    );
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (!(err instanceof DomainError)) console.error('confirmation mail failed', orderId, err);
    await ctx.db.query('update orders set confirmation_error = $2 where id = $1', [
      orderId,
      reason.slice(0, 500),
    ]);
    return false;
  }
}

/**
 * Sends the confirmations that are due: new paid orders at once, failed ones again after a
 * pause. Orders are claimed first, so two runs at the same time never send a mail twice.
 */
export async function deliverConfirmations(
  ctx: AppContext,
): Promise<{ sent: number; failed: number }> {
  const claimed = await ctx.db.query<{ id: string }>(
    `update orders
     set confirmation_attempts = confirmation_attempts + 1, confirmation_last_attempt_at = now()
     where id in (
       select id from orders
       where status = 'paid'
         and confirmation_sent_at is null
         and customer_email is not null
         and confirmation_attempts < $1
         and (confirmation_last_attempt_at is null
              or confirmation_last_attempt_at < now() - make_interval(mins => $2))
       order by paid_at
       limit $3
       for update skip locked
     )
     returning id`,
    [MAX_ATTEMPTS, RETRY_AFTER_MINUTES, BATCH_SIZE],
  );

  let sent = 0;
  for (const { id } of claimed) {
    if (await attempt(ctx, id)) sent++;
  }
  return { sent, failed: claimed.length - sent };
}

/** Sends the confirmation again, for example after the online URL changed. */
export async function resendConfirmation(ctx: AppContext, orderId: string): Promise<Order> {
  const order = await getOrder(ctx.db, orderId);
  if (order.status !== 'paid') {
    throw new DomainError('conflict', `Confirmations are only sent for paid orders. This order is ${order.status}.`);
  }
  await sendConfirmation(ctx, order);
  await ctx.db.query(
    'update orders set confirmation_sent_at = now(), confirmation_error = null where id = $1',
    [order.id],
  );
  return getOrder(ctx.db, order.id);
}

/** Queues the confirmation again for every paid order of an event. Returns the number of orders. */
export async function requeueConfirmations(
  ctx: AppContext,
  eventIdOrSlug: string,
  attendance?: 'online' | 'onsite',
): Promise<number> {
  const event = await getEvent(ctx.db, eventIdOrSlug);
  const rows = await ctx.db.query(
    `update orders o
     set confirmation_sent_at = null, confirmation_attempts = 0,
         confirmation_last_attempt_at = null, confirmation_error = null
     from ticket_types t
     where t.id = o.ticket_type_id and o.event_id = $1 and o.status = 'paid'
       and o.customer_email is not null
       and ($2::text is null or t.attendance = $2::text)
     returning o.id`,
    [event.id, attendance ?? null],
  );
  return rows.length;
}
