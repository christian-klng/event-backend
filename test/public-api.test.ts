import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createEvent, setEventStatus } from '../src/domain/events.ts';
import type { EventInput } from '../src/domain/events.ts';
import { updateGeneralSettings } from '../src/domain/settings.ts';
import { createTestApp, daysFromNow, eventInput } from './helpers.ts';
import type { TestApp } from './helpers.ts';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
beforeEach(() => t.reset());
afterAll(() => t.close());

async function publish(overrides: Partial<EventInput> = {}) {
  const event = await createEvent(t.db, eventInput(overrides));
  return (await setEventStatus(t.db, event.id, 'published')).event;
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  const response = await t.app.request(path, { headers });
  return { response, body: (await response.json()) as any };
}

describe('GET /v1/events', () => {
  it('lists published upcoming events in order and hides drafts', async () => {
    await createEvent(t.db, eventInput({ title: 'Entwurf' }));
    await publish({ title: 'Später', starts_at: daysFromNow(40), ends_at: daysFromNow(41) });
    await publish({ title: 'Früher', starts_at: daysFromNow(10), ends_at: daysFromNow(11) });

    const { response, body } = await getJson('/v1/events');
    expect(response.status).toBe(200);
    expect(body.events.map((event: any) => event.title)).toEqual(['Früher', 'Später']);
    expect(body.events[0]).toMatchObject({
      format: 'hybrid',
      price_from_cents: 29000,
      currency: 'eur',
      bookable: true,
      sold_out: false,
    });
    expect(body.events[0]).not.toHaveProperty('description_html');
  });

  it('separates past from upcoming events', async () => {
    const past = await publish({ title: 'Vorbei' });
    await t.db.query('update events set starts_at = $1, ends_at = $2 where id = $3', [
      daysFromNow(-3),
      daysFromNow(-2),
      past.id,
    ]);
    await publish({ title: 'Kommt' });

    expect((await getJson('/v1/events')).body.events.map((e: any) => e.title)).toEqual(['Kommt']);
    expect((await getJson('/v1/events?when=past')).body.events.map((e: any) => e.title)).toEqual([
      'Vorbei',
    ]);
    expect((await getJson('/v1/events?when=all')).body.events).toHaveLength(2);
    expect((await getJson('/v1/events?when=never')).response.status).toBe(400);
  });
});

describe('GET /v1/events/:slug', () => {
  it('never exposes the online URL or sales figures', async () => {
    const event = await publish({ description_md: 'Mit **Praxis**.' });
    await t.addOrder({
      event_id: event.id,
      ticket_type_id: event.ticket_types[0]!.id,
      quantity: 2,
      status: 'paid',
    });

    const { response, body } = await getJson(`/v1/events/${event.slug}`);
    const raw = JSON.stringify(body);
    expect(response.status).toBe(200);
    expect(raw).not.toContain('secret-room');
    expect(raw).not.toContain('online_url');
    expect(raw).not.toContain('"sold"');
    expect(raw).not.toContain('capacity');
    expect(body.event.description_html).toContain('<strong>Praxis</strong>');
    expect(body.event.location).toEqual({ name: 'Seminarhaus', address: 'Beispielweg 1, 10115 Berlin' });
  });

  it('can be addressed by ID as well', async () => {
    const event = await publish();
    expect((await getJson(`/v1/events/${event.id}`)).body.event.slug).toBe(event.slug);
  });

  it('hides drafts and archived events, shows cancelled ones as not bookable', async () => {
    const draft = await createEvent(t.db, eventInput({ title: 'Entwurf' }));
    expect((await getJson(`/v1/events/${draft.slug}`)).response.status).toBe(404);

    const event = await publish({ title: 'Abgesagt' });
    await setEventStatus(t.db, event.id, 'cancelled');
    const { body } = await getJson(`/v1/events/${event.slug}`);
    expect(body.event).toMatchObject({ status: 'cancelled', bookable: false });

    await setEventStatus(t.db, event.id, 'archived');
    expect((await getJson(`/v1/events/${event.slug}`)).response.status).toBe(404);
    expect((await getJson('/v1/events/unknown')).response.status).toBe(404);
  });

  it('escapes HTML in descriptions', async () => {
    const event = await publish({
      description_md: '<script>alert(1)</script>\n\n[link](javascript:alert(1))',
    });
    const html: string = (await getJson(`/v1/events/${event.slug}`)).body.event.description_html;
    expect(html).not.toContain('<script');
    expect(html).not.toContain('href="javascript');
  });

  it('reveals free seats only when few are left', async () => {
    const event = await publish();
    const onsite = event.ticket_types[0]!;
    const ticketsOf = async () => (await getJson(`/v1/events/${event.slug}`)).body.event.tickets;

    expect((await ticketsOf())[0]).toMatchObject({ remaining: null, sold_out: false, on_sale: true });

    await t.addOrder({ event_id: event.id, ticket_type_id: onsite.id, quantity: 17, status: 'paid' });
    expect((await ticketsOf())[0]).toMatchObject({ remaining: 3, max_per_order: 3, on_sale: true });

    await t.addOrder({
      event_id: event.id,
      ticket_type_id: onsite.id,
      quantity: 3,
      status: 'pending',
      expires_at: daysFromNow(0, 1),
    });
    const tickets = await ticketsOf();
    expect(tickets[0]).toMatchObject({ remaining: 0, sold_out: true, on_sale: false });
    expect(tickets[1]).toMatchObject({ remaining: null, sold_out: false, on_sale: true });
  });

  it('respects the sales window of a ticket type', async () => {
    const event = await publish({
      ticket_types: [
        { name: 'Bald', attendance: 'onsite', price_cents: 100, sales_start: daysFromNow(2) },
        { name: 'Vorbei', attendance: 'onsite', price_cents: 100, sales_end: daysFromNow(-1) },
        { name: 'Jetzt', attendance: 'online', price_cents: 100 },
      ],
    });
    const { body } = await getJson(`/v1/events/${event.slug}`);
    expect(body.event.tickets.map((ticket: any) => ticket.on_sale)).toEqual([false, false, true]);
  });
});

describe('CORS', () => {
  it('allows any website until origins are configured', async () => {
    const { response } = await getJson('/v1/events', { origin: 'https://anywhere.example' });
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('allows only configured websites afterwards', async () => {
    await updateGeneralSettings(t.db, { allowed_origins: ['https://www.example.com'] });
    t.ctx.invalidateSettings();

    const allowed = await getJson('/v1/events', { origin: 'https://www.example.com' });
    expect(allowed.response.headers.get('access-control-allow-origin')).toBe('https://www.example.com');

    const denied = await getJson('/v1/events', { origin: 'https://evil.example' });
    expect(denied.response.headers.get('access-control-allow-origin')).toBeNull();

    const preflight = await t.app.request('/v1/events', {
      method: 'OPTIONS',
      headers: { origin: 'https://www.example.com', 'access-control-request-method': 'POST' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-methods')).toContain('POST');
  });
});

describe('GET /healthz', () => {
  it('reports a working database', async () => {
    const { response, body } = await getJson('/healthz');
    expect(response.status).toBe(200);
    expect(body).toEqual({ ok: true });
  });
});
