import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deliverConfirmations } from '../src/domain/confirmation.ts';
import { createEvent, setEventStatus, updateTicketType } from '../src/domain/events.ts';
import type { EventInput, EventRecord } from '../src/domain/events.ts';
import { expireOverdueOrders } from '../src/domain/orders.ts';
import { createFakeStripe } from './fake-stripe.ts';
import { createTestApp, daysFromNow, eventInput } from './helpers.ts';
import type { TestApp } from './helpers.ts';

const stripe = createFakeStripe();
const mails: any[] = [];
let mailFailure: string | null = null;
let visitor = 0;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    stripe: { fetch: stripe.fetch },
    mailTransport: () => ({
      sendMail: async (message: any) => {
        if (mailFailure) throw new Error(mailFailure);
        mails.push(message);
        return { messageId: `<${mails.length}@example.test>` } as any;
      },
    }),
  });
});
beforeEach(async () => {
  await t.reset();
  stripe.reset();
  mails.length = 0;
  mailFailure = null;
});
afterAll(() => t.close());

async function prepareSales(settings: Record<string, unknown> = {}) {
  await t.callTool('update_settings', {
    organizer_name: 'Beispiel Akademie',
    checkout_success_url: 'https://www.example.com/danke',
    checkout_cancel_url: 'https://www.example.com/seminare',
    default_tax_percent: 19,
    ...settings,
  });
  await t.callTool('update_mail_settings', {
    host: 'smtp.example.test',
    from_name: 'Beispiel Akademie',
    from_email: 'events@example.test',
  });
  await t.callTool('update_stripe_settings', { secret_key: 'sk_test_abc123abc123abc123' });
  await t.callTool('create_stripe_webhook');
  stripe.requests.length = 0;
}

async function prepareSettingsOnly() {
  await t.callTool('update_settings', {
    checkout_success_url: 'https://www.example.com/danke',
    checkout_cancel_url: 'https://www.example.com/seminare',
    default_tax_percent: 19,
  });
}

async function publish(overrides: Partial<EventInput> = {}): Promise<EventRecord> {
  const event = await createEvent(t.db, eventInput(overrides));
  return (await setEventStatus(t.db, event.id, 'published')).event;
}

/** Every call comes from another visitor, unless an address is given. */
async function checkout(body: unknown, address = `203.0.113.${++visitor % 250}, 10.0.0.1, 198.51.${visitor % 250}.7`) {
  const response = await t.app.request('/v1/checkout', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': address },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: (await response.json()) as any };
}

async function webhook(type: string, object: Record<string, unknown>, eventId?: string) {
  const event = await stripe.signedEvent(type, object, eventId);
  const response = await t.app.request('/webhooks/stripe', {
    method: 'POST',
    headers: { 'stripe-signature': event.signature, 'content-type': 'application/json' },
    body: event.payload,
  });
  await t.ctx.idle();
  return response;
}

function paidSession(order: { order_id: string; checkout_url: string }, fields: Record<string, unknown> = {}) {
  return {
    id: order.checkout_url.split('/').at(-1),
    object: 'checkout.session',
    client_reference_id: order.order_id,
    payment_status: 'paid',
    amount_total: 49000,
    currency: 'eur',
    payment_intent: 'pi_test_1',
    invoice: null,
    customer_details: { email: 'kundin@example.test', name: 'Maria Muster', business_name: null },
    ...fields,
  };
}

async function buy(ticketTypeId: string, quantity = 1, fields: Record<string, unknown> = {}) {
  const started = await checkout({ ticket_type_id: ticketTypeId, quantity });
  expect(started.status).toBe(201);
  const session = paidSession(started.body, fields);
  await webhook('checkout.session.completed', session);
  return { order_id: started.body.order_id as string, session_id: session.id as string };
}

const orderOf = async (id: string) => (await t.callTool('get_order', { order_id: id })).data;
const orderCount = async () =>
  (await t.db.query<{ count: number }>('select count(*)::int as count from orders'))[0]!.count;
const remainingOf = async (event: EventRecord, index = 0) =>
  ((await (await t.app.request(`/v1/events/${event.slug}`)).json()) as any).event.tickets[index];

describe('connecting Stripe', () => {
  it('lists what is missing before tickets can be sold', async () => {
    const status = (await t.callTool('get_stripe_status')).data;
    expect(status).toMatchObject({ connected: false, ready_for_sales: false, mode: null });
    expect(status.problems).toHaveLength(4);

    const event = await createEvent(t.db, eventInput());
    const published = await t.callTool('set_event_status', { event: event.id, status: 'published' });
    expect(published.data.warnings.join(' ')).toContain('Tickets cannot be bought yet');
  });

  it('is ready after keys, webhook, URLs and tax rate are set', async () => {
    await t.callTool('update_settings', {
      checkout_success_url: 'https://www.example.com/danke',
      checkout_cancel_url: 'https://www.example.com/seminare',
      default_tax_percent: 19,
    });
    const connected = await t.callTool('update_stripe_settings', { secret_key: 'sk_test_abc123abc123abc123' });
    expect(connected.data.status).toMatchObject({
      connected: true,
      mode: 'test',
      account: { id: 'acct_test', name: 'Beispiel Akademie', charges_enabled: true },
      ready_for_sales: false,
    });

    const created = await t.callTool('create_stripe_webhook');
    expect(created.data.webhook.url).toBe('https://events.example.test/webhooks/stripe');
    expect(created.data.status).toMatchObject({ ready_for_sales: true, problems: [] });

    const [request] = stripe.requestsTo('POST /v1/webhook_endpoints');
    expect(request!.params).toMatchObject({
      url: 'https://events.example.test/webhooks/stripe',
      'enabled_events[0]': 'checkout.session.completed',
      'enabled_events[4]': 'charge.refunded',
    });
  });

  it('never reveals keys and stores them encrypted', async () => {
    const result = await t.callTool('update_stripe_settings', { secret_key: 'sk_test_abc123abc123abc123' });
    await t.callTool('create_stripe_webhook');
    const outputs = [
      result.text,
      (await t.callTool('get_stripe_status')).text,
      (await t.callTool('get_settings')).text,
      JSON.stringify(await t.db.query('select value from settings')),
    ].join('\n');
    expect(outputs).not.toContain('sk_test_abc123abc123abc123');
    expect(outputs).not.toContain('whsec_test_secret');
  });

  it('rejects keys that are malformed or refused by Stripe', async () => {
    const malformed = await t.callTool('update_stripe_settings', { secret_key: 'pk_test_abc' });
    expect(malformed.text).toContain('starts with sk_test_');

    const revoked = await t.callTool('update_stripe_settings', { secret_key: 'sk_test_revoked00000000000' });
    expect(revoked.text).toContain('rejected the secret key');
    expect((await t.callTool('get_stripe_status')).data.connected).toBe(false);
  });

  it('says what is wrong with a key from the environment, without showing it', async () => {
    const cases: [string, string][] = [
      ['pk_test_abc123abc123abc123', 'publishable key'],
      ['whsec_abc123abc123abc123', 'webhook secret'],
      ['"sk_test_abc123abc123abc123"', 'quotation marks'],
      ['sk_test_abc123', 'too short (14 characters)'],
      ['sk_test_abc123abc123 abc123', 'characters that do not belong in a key'],
      ['sk_abc123abc123abc123abc123', 'lacks the part that says test or live'],
      ['my-stripe-password', 'does not look like a Stripe key'],
    ];
    try {
      for (const [key, expected] of cases) {
        t.ctx.config.stripeSecretKeyOverride = key;
        const status = await t.callTool('get_stripe_status');
        expect(status.data, key).toMatchObject({ connected: false, mode: null, secret_key_source: 'environment' });
        expect(status.data.problems.join(' '), key).toContain('STRIPE_SECRET_KEY in the environment is not usable.');
        expect(status.data.problems.join(' '), key).toContain(expected);
        expect(status.text, key).not.toContain(key.replace(/"/g, ''));
      }
      // Malformed keys never reach Stripe.
      expect(stripe.requests).toHaveLength(0);

      await prepareSettingsOnly();
      const event = await publish();
      expect(await checkout({ ticket_type_id: event.ticket_types[0]!.id })).toMatchObject({
        status: 503,
        body: { message: 'Ticket sales are not available at the moment.' },
      });
    } finally {
      t.ctx.config.stripeSecretKeyOverride = undefined;
    }
  });

  it('tells a well-formed but rejected key apart', async () => {
    try {
      t.ctx.config.stripeSecretKeyOverride = 'sk_test_revoked00000000000';
      const status = (await t.callTool('get_stripe_status')).data;
      expect(status).toMatchObject({ connected: false, mode: 'test' });
      expect(status.problems.join(' ')).toContain(
        'Its form is right (test mode, 26 characters), so it was probably deleted or replaced',
      );
    } finally {
      t.ctx.config.stripeSecretKeyOverride = undefined;
    }
  });

  it('explains malformed keys passed through MCP', async () => {
    const publishable = await t.callTool('update_stripe_settings', { secret_key: 'pk_live_abc123abc123abc123' });
    expect(publishable.text).toContain('publishable key');
    // Spaces around a pasted key are harmless.
    const padded = await t.callTool('update_stripe_settings', { secret_key: '  sk_test_abc123abc123abc123\n' });
    expect(padded.data.status).toMatchObject({ connected: true, mode: 'test' });
  });

  it('resets the webhook when switching from test to live mode', async () => {
    await prepareSales();
    const switched = await t.callTool('update_stripe_settings', { secret_key: 'sk_live_abc123abc123abc123' });
    expect(switched.data.notes[0]).toContain('test to live');
    expect(switched.data.status).toMatchObject({ mode: 'live', webhook: { secret_set: false } });
  });
});

describe('POST /v1/checkout', () => {
  it('reserves seats and opens a Stripe Checkout', async () => {
    await prepareSales({ terms_url: 'https://www.example.com/agb', invoice_footer: 'Vielen Dank.' });
    const event = await publish();
    const onsite = event.ticket_types[0]!;

    const { status, body } = await checkout({ ticket_type_id: onsite.id, quantity: 2 });
    expect(status).toBe(201);
    expect(body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.com\//);

    const [request] = stripe.requestsTo('POST /v1/checkout/sessions');
    expect(request!.params).toMatchObject({
      mode: 'payment',
      client_reference_id: body.order_id,
      'line_items[0][quantity]': '2',
      'line_items[0][price_data][currency]': 'eur',
      'line_items[0][price_data][unit_amount]': '49000',
      'line_items[0][price_data][product_data][name]': `${event.title} – Präsenz`,
      'line_items[0][tax_rates][0]': expect.stringMatching(/^txr_/),
      success_url: 'https://www.example.com/danke?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.example.com/seminare',
      billing_address_collection: 'required',
      'tax_id_collection[enabled]': 'true',
      'invoice_creation[enabled]': 'true',
      'invoice_creation[invoice_data][footer]': 'Vielen Dank.',
      'metadata[order_id]': body.order_id,
    });
    expect(request!.params['custom_text[submit][message]']).toContain('https://www.example.com/agb');

    const minutes = (Number(request!.params.expires_at) * 1000 - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(30);
    expect(minutes).toBeLessThan(32);

    const order = await orderOf(body.order_id);
    expect(order).toMatchObject({ status: 'pending', quantity: 2, unit_price_cents: 49000, livemode: false });
    expect(new Date(order.expires_at).getTime()).toBeGreaterThan(Number(request!.params.expires_at) * 1000);

    const admin = (await t.callTool('get_event', { event: event.id })).data;
    expect(admin.ticket_types[0]).toMatchObject({ sold: 0, reserved: 2, available: 18 });
  });

  it('creates the tax rate once and uses the rate of the event when it has one', async () => {
    await prepareSales();
    const regular = await publish();
    const reduced = await publish({ title: 'Ermäßigt', tax_percent: 7 });
    const exempt = await publish({ title: 'Steuerfrei', tax_percent: 0 });

    await checkout({ ticket_type_id: regular.ticket_types[0]!.id });
    await checkout({ ticket_type_id: regular.ticket_types[1]!.id });
    await checkout({ ticket_type_id: reduced.ticket_types[0]!.id });
    await checkout({ ticket_type_id: exempt.ticket_types[0]!.id });

    expect(stripe.requestsTo('POST /v1/tax_rates').map((request) => request.params)).toMatchObject([
      { percentage: '19', inclusive: 'true' },
      { percentage: '7', inclusive: 'true' },
    ]);
    const sessions = stripe.requestsTo('POST /v1/checkout/sessions');
    expect(sessions[0]!.params['line_items[0][tax_rates][0]']).toBe(
      sessions[1]!.params['line_items[0][tax_rates][0]'],
    );
    expect(sessions[3]!.params).not.toHaveProperty('line_items[0][tax_rates][0]');
  });

  it('sells the last seats only once', async () => {
    await prepareSales();
    const event = await publish();
    const onsite = event.ticket_types[0]!;
    await updateTicketType(t.db, onsite.id, { capacity: 3 });

    expect((await checkout({ ticket_type_id: onsite.id, quantity: 2 })).status).toBe(201);

    const tooMany = await checkout({ ticket_type_id: onsite.id, quantity: 2 });
    expect(tooMany).toMatchObject({ status: 409, body: { reason: 'not_enough_seats' } });
    expect(tooMany.body.message).toBe('Only 1 seat is left.');

    expect((await checkout({ ticket_type_id: onsite.id, quantity: 1 })).status).toBe(201);
    expect(await checkout({ ticket_type_id: onsite.id })).toMatchObject({
      status: 409,
      body: { reason: 'sold_out' },
    });
    expect(await remainingOf(event)).toMatchObject({ sold_out: true, on_sale: false, remaining: 0 });
    expect(await orderCount()).toBe(2);
  });

  it('never oversells when many buyers arrive at once', async () => {
    await prepareSales();
    const event = await publish();
    const onsite = event.ticket_types[0]!;
    await updateTicketType(t.db, onsite.id, { capacity: 5 });

    const results = await Promise.all(
      Array.from({ length: 12 }, () => checkout({ ticket_type_id: onsite.id, quantity: 1 })),
    );
    expect(results.filter((result) => result.status === 201)).toHaveLength(5);
    expect(results.filter((result) => result.status === 409)).toHaveLength(7);
    expect(await orderCount()).toBe(5);
  });

  it('frees the seats when a reservation runs out', async () => {
    await prepareSales();
    const event = await publish();
    const onsite = event.ticket_types[0]!;
    await updateTicketType(t.db, onsite.id, { capacity: 1 });

    const first = await checkout({ ticket_type_id: onsite.id });
    expect((await checkout({ ticket_type_id: onsite.id })).status).toBe(409);

    await t.db.query('update orders set expires_at = $1 where id = $2', [
      daysFromNow(0, -1),
      first.body.order_id,
    ]);
    expect((await checkout({ ticket_type_id: onsite.id })).status).toBe(201);

    expect(await expireOverdueOrders(t.db)).toBe(1);
    expect((await orderOf(first.body.order_id)).status).toBe('expired');
  });

  it('refuses tickets that are not on sale', async () => {
    await prepareSales();
    const draft = await createEvent(t.db, eventInput());
    const cancelled = await publish();
    await setEventStatus(t.db, cancelled.id, 'cancelled');
    const windows = await publish({
      ticket_types: [
        { name: 'Bald', attendance: 'onsite', price_cents: 1000, sales_start: daysFromNow(2) },
        { name: 'Vorbei', attendance: 'onsite', price_cents: 1000, sales_end: daysFromNow(-1) },
        { name: 'Klein', attendance: 'onsite', price_cents: 1000, max_per_order: 2 },
      ],
    });

    expect((await checkout({ ticket_type_id: draft.ticket_types[0]!.id })).status).toBe(404);
    expect(await checkout({ ticket_type_id: cancelled.ticket_types[0]!.id })).toMatchObject({
      status: 409,
      body: { reason: 'not_on_sale' },
    });
    expect((await checkout({ ticket_type_id: windows.ticket_types[0]!.id })).body.reason).toBe('not_on_sale');
    expect((await checkout({ ticket_type_id: windows.ticket_types[1]!.id })).body.reason).toBe('not_on_sale');
    expect(await checkout({ ticket_type_id: windows.ticket_types[2]!.id, quantity: 3 })).toMatchObject({
      status: 400,
      body: { reason: 'quantity' },
    });
    expect((await checkout({ ticket_type_id: 'unknown' })).status).toBe(404);
    expect((await checkout({ quantity: 1 })).status).toBe(400);
    expect((await checkout({ ticket_type_id: windows.ticket_types[2]!.id, quantity: 0 })).status).toBe(400);

    expect(await orderCount()).toBe(0);
    expect(stripe.requestsTo('POST /v1/checkout/sessions')).toHaveLength(0);
  });

  it('stays closed while the setup is incomplete, without telling buyers why', async () => {
    const event = await publish();
    const unconfigured = await checkout({ ticket_type_id: event.ticket_types[0]!.id });
    expect(unconfigured).toMatchObject({ status: 503, body: { reason: 'not_configured' } });
    expect(unconfigured.body.message).toBe('Ticket sales are not available at the moment.');

    await prepareSales({ default_tax_percent: null });
    expect((await checkout({ ticket_type_id: event.ticket_types[0]!.id })).status).toBe(503);
    expect(await orderCount()).toBe(0);
  });

  it('releases the seats when Stripe fails', async () => {
    await prepareSales();
    const event = await publish();
    await checkout({ ticket_type_id: event.ticket_types[0]!.id });

    stripe.failNext(400, 'Invalid tax_rates', 'invalid_request_error');
    const failed = await checkout({ ticket_type_id: event.ticket_types[0]!.id });
    expect(failed).toMatchObject({ status: 503, body: { reason: 'payment_provider' } });
    expect(JSON.stringify(failed.body)).not.toContain('tax_rates');
    expect(await orderCount()).toBe(1);
  });

  it('limits how many checkouts one visitor may open', async () => {
    await prepareSales();
    const event = await publish();
    const body = { ticket_type_id: event.ticket_types[1]!.id };
    // The proxy appends the real address, so the last entry counts.
    const address = (spoofed: number) => `1.2.3.${spoofed}, 198.51.100.200`;

    for (let i = 0; i < 10; i++) expect((await checkout(body, address(i))).status).toBe(201);
    expect((await checkout(body, address(99))).status).toBe(429);
    expect((await checkout(body)).status).toBe(201);
  });
});

describe('payment confirmation', () => {
  it('rejects webhooks without a valid signature', async () => {
    await prepareSales();
    const event = await stripe.signedEvent('checkout.session.completed', { id: 'cs_test_x' });
    const forged = await t.app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': event.signature },
      body: event.payload.replace('cs_test_x', 'cs_test_y'),
    });
    expect(forged.status).toBe(400);

    const unsigned = await t.app.request('/webhooks/stripe', { method: 'POST', body: event.payload });
    expect(unsigned.status).toBe(400);
  });

  it('answers 503 while no webhook secret is known', async () => {
    const event = await stripe.signedEvent('checkout.session.completed', { id: 'cs_test_x' });
    const response = await t.app.request('/webhooks/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': event.signature },
      body: event.payload,
    });
    expect(response.status).toBe(503);
  });

  it('marks the order as paid and sends the access link to online buyers', async () => {
    await prepareSales({ confirmation_footer: 'Fragen? Schreiben Sie an kontakt@example.test.' });
    const event = await publish({
      starts_at: new Date('2030-11-05T08:00:00Z'),
      ends_at: new Date('2030-11-05T16:00:00Z'),
    });
    const { order_id } = await buy(event.ticket_types[1]!.id, 2, { amount_total: 58000 });

    expect(await orderOf(order_id)).toMatchObject({
      status: 'paid',
      customer_email: 'kundin@example.test',
      customer_name: 'Maria Muster',
      amount_total_cents: 58000,
      stripe_payment_intent_id: 'pi_test_1',
      tax_percent: 19,
      confirmation: { attempts: 1, error: null },
    });

    expect(mails).toHaveLength(1);
    const [mail] = mails;
    expect(mail).toMatchObject({
      to: 'kundin@example.test',
      subject: `Ihre Anmeldung: ${event.title}`,
      from: { name: 'Beispiel Akademie', address: 'events@example.test' },
    });
    expect(mail.text).toContain('Guten Tag Maria Muster,');
    expect(mail.text).toContain('Dienstag, 5. November 2030, 09:00–17:00 Uhr');
    expect(mail.text).toContain('2 × Online');
    expect(mail.text).toContain('https://meet.example.test/secret-room');
    expect(mail.text).toContain('Fragen? Schreiben Sie an kontakt@example.test.');
    expect(mail.text).not.toContain('Beispielweg');
    expect(mail.html).toContain('<a href="https://meet.example.test/secret-room">');

    const calendar: string = mail.attachments[0].content;
    expect(mail.attachments[0].filename).toBe('termin.ics');
    expect(calendar).toContain('DTSTART:20301105T080000Z');
    expect(calendar).toContain('DTEND:20301105T160000Z');
    expect(calendar).toContain('LOCATION:Online');
  });

  it('sends the venue, not the access link, to on-site buyers', async () => {
    await prepareSales();
    const event = await publish();
    await buy(event.ticket_types[0]!.id);

    expect(mails[0].text).toContain('Seminarhaus, Beispielweg 1, 10115 Berlin');
    expect(JSON.stringify(mails[0])).not.toContain('secret-room');
    expect(mails[0].attachments[0].content).toContain('LOCATION:Seminarhaus\\, Beispielweg 1\\, 10115 Berlin');
  });

  it('promises the link for later when none is set yet', async () => {
    await prepareSales();
    const event = await publish({ online_url: null });
    await buy(event.ticket_types[1]!.id);
    expect(mails[0].text).toContain('rechtzeitig vor dem Termin');
  });

  it('escapes what buyers typed into the checkout', async () => {
    await prepareSales();
    const event = await publish();
    await buy(event.ticket_types[0]!.id, 1, {
      customer_details: { email: 'x@example.test', name: '<img src=x onerror=alert(1)>' },
    });
    expect(mails[0].html).not.toContain('<img');
    expect(mails[0].html).toContain('&lt;img');
  });

  it('handles a webhook that arrives twice only once', async () => {
    await prepareSales();
    const event = await publish();
    const started = await checkout({ ticket_type_id: event.ticket_types[0]!.id });
    const session = paidSession(started.body);

    expect((await webhook('checkout.session.completed', session, 'evt_same')).status).toBe(200);
    expect((await webhook('checkout.session.completed', session, 'evt_same')).status).toBe(200);
    expect((await webhook('checkout.session.completed', session, 'evt_other')).status).toBe(200);

    expect(mails).toHaveLength(1);
    expect((await t.callTool('get_event', { event: event.id })).data.ticket_types[0]).toMatchObject({
      sold: 1,
      reserved: 0,
    });
  });

  it('ignores events it does not know and sessions of others', async () => {
    await prepareSales();
    expect((await webhook('customer.created', { id: 'cus_1' })).status).toBe(200);
    const foreign = paidSession({ order_id: 'not-ours', checkout_url: 'x/cs_test_foreign' });
    expect((await webhook('checkout.session.completed', foreign)).status).toBe(200);
    expect(mails).toHaveLength(0);
  });

  it('frees the seats when the checkout expires', async () => {
    await prepareSales();
    const event = await publish();
    const started = await checkout({ ticket_type_id: event.ticket_types[0]!.id, quantity: 4 });
    await webhook('checkout.session.expired', { id: paidSession(started.body).id });

    expect((await orderOf(started.body.order_id)).status).toBe('expired');
    expect((await t.callTool('get_event', { event: event.id })).data.ticket_types[0].available).toBe(20);
  });

  it('counts a payment that arrives after the reservation ran out', async () => {
    await prepareSales();
    const event = await publish();
    const started = await checkout({ ticket_type_id: event.ticket_types[0]!.id });
    await t.db.query("update orders set status = 'expired' where id = $1", [started.body.order_id]);

    await webhook('checkout.session.completed', paidSession(started.body));
    expect((await orderOf(started.body.order_id)).status).toBe('paid');
    expect(mails).toHaveLength(1);
  });

  it('keeps seats for payments that are confirmed days later', async () => {
    await prepareSales();
    const event = await publish();
    const started = await checkout({ ticket_type_id: event.ticket_types[0]!.id });
    const session = paidSession(started.body, { payment_status: 'unpaid' });

    await webhook('checkout.session.completed', session);
    const waiting = await orderOf(started.body.order_id);
    expect(waiting).toMatchObject({ status: 'pending', customer_email: 'kundin@example.test' });
    expect(new Date(waiting.expires_at).getTime()).toBeGreaterThan(daysFromNow(9).getTime());
    expect(mails).toHaveLength(0);

    await webhook('checkout.session.async_payment_succeeded', { ...session, payment_status: 'paid' });
    expect((await orderOf(started.body.order_id)).status).toBe('paid');
    expect(mails).toHaveLength(1);
  });

  it('cancels the order when a delayed payment fails', async () => {
    await prepareSales();
    const event = await publish();
    const started = await checkout({ ticket_type_id: event.ticket_types[0]!.id });
    const session = paidSession(started.body, { payment_status: 'unpaid' });
    await webhook('checkout.session.completed', session);
    await webhook('checkout.session.async_payment_failed', session);

    expect((await orderOf(started.body.order_id)).status).toBe('cancelled');
    expect(mails).toHaveLength(0);
  });
});

describe('confirmation mails', () => {
  it('tries again later when the mail server fails', async () => {
    await prepareSales();
    const event = await publish();
    mailFailure = '421 Service not available';
    const { order_id } = await buy(event.ticket_types[0]!.id);

    expect(await orderOf(order_id)).toMatchObject({
      status: 'paid',
      confirmation: { sent_at: null, attempts: 1 },
    });
    expect((await orderOf(order_id)).confirmation.error).toContain('421 Service not available');

    mailFailure = null;
    expect(await deliverConfirmations(t.ctx)).toEqual({ sent: 0, failed: 0 });

    await t.db.query('update orders set confirmation_last_attempt_at = $1', [daysFromNow(0, -1)]);
    expect(await deliverConfirmations(t.ctx)).toEqual({ sent: 1, failed: 0 });
    expect(await deliverConfirmations(t.ctx)).toEqual({ sent: 0, failed: 0 });
    expect(mails).toHaveLength(1);
    expect((await orderOf(order_id)).confirmation).toMatchObject({ attempts: 2, error: null });
  });

  it('gives up after several attempts', async () => {
    await prepareSales();
    const event = await publish();
    mailFailure = '550 Mailbox unavailable';
    await buy(event.ticket_types[0]!.id);

    for (let i = 0; i < 10; i++) {
      await t.db.query('update orders set confirmation_last_attempt_at = $1', [daysFromNow(0, -1)]);
      await deliverConfirmations(t.ctx);
    }
    const [order] = (await t.callTool('list_orders')).data.orders;
    expect(order.confirmation.attempts).toBe(6);
  });

  it('informs buyers when the access link changes', async () => {
    await prepareSales();
    const event = await publish();
    await buy(event.ticket_types[0]!.id);
    await buy(event.ticket_types[1]!.id);
    await buy(event.ticket_types[1]!.id, 1, {
      customer_details: { email: 'zweiter@example.test', name: 'Zweiter Kunde' },
    });
    mails.length = 0;

    const updated = await t.callTool('update_event', {
      event: event.id,
      online_url: 'https://meet.example.test/new-room',
    });
    expect(updated.data.warnings[0]).toContain('3 tickets are already sold and online_url changed');

    const resent = await t.callTool('resend_confirmations', { event: event.id, attendance: 'online' });
    expect(resent.data).toMatchObject({ orders: 2, sent: 2, failed: 0 });
    expect(mails.map((mail) => mail.to).sort()).toEqual(['kundin@example.test', 'zweiter@example.test']);
    expect(mails.every((mail) => mail.text.includes('https://meet.example.test/new-room'))).toBe(true);
  });

  it('can be sent again for a single order', async () => {
    await prepareSales();
    const event = await publish();
    const { order_id } = await buy(event.ticket_types[0]!.id);
    const pending = await checkout({ ticket_type_id: event.ticket_types[0]!.id });

    expect((await t.callTool('resend_confirmation', { order_id })).data.sent).toBe(true);
    expect(mails).toHaveLength(2);
    expect((await t.callTool('resend_confirmation', { order_id: pending.body.order_id })).text).toContain(
      'only sent for paid orders',
    );
  });
});

describe('refunds', () => {
  it('corrects the invoice with a credit note and frees the seats', async () => {
    await prepareSales();
    const event = await publish();
    const { order_id, session_id } = await buy(event.ticket_types[0]!.id, 2, { amount_total: 98000 });
    // Stripe creates the invoice shortly after the payment.
    stripe.completeSession(session_id, { invoice: 'in_test_1', payment_intent: 'pi_test_1' });

    const refund = await t.callTool('refund_order', { order_id });
    expect(refund.data).toMatchObject({
      refunded: true,
      credit_note_id: expect.stringMatching(/^cn_/),
      refund_id: null,
      order: { status: 'refunded' },
    });

    const [request] = stripe.requestsTo('POST /v1/credit_notes');
    expect(request).toMatchObject({
      params: { invoice: 'in_test_1', amount: '98000', refund_amount: '98000' },
      idempotencyKey: `refund-${order_id}`,
    });
    expect(stripe.requestsTo('POST /v1/refunds')).toHaveLength(0);
    expect((await t.callTool('get_event', { event: event.id })).data.ticket_types[0]).toMatchObject({
      sold: 0,
      available: 20,
    });

    expect((await t.callTool('refund_order', { order_id })).text).toContain('This order is refunded');
  });

  it('refunds the payment directly when there is no invoice', async () => {
    await prepareSales({ stripe_invoices: false });
    const event = await publish();
    const { order_id, session_id } = await buy(event.ticket_types[0]!.id);
    stripe.completeSession(session_id, { payment_intent: 'pi_test_1' });

    const refund = await t.callTool('refund_order', { order_id });
    expect(refund.data.refund_id).toMatch(/^re_/);
    expect(stripe.requestsTo('POST /v1/refunds')[0]!.params.payment_intent).toBe('pi_test_1');
    expect(stripe.requestsTo('POST /v1/checkout/sessions')[0]!.params).not.toHaveProperty(
      'invoice_creation[enabled]',
    );
  });

  it('keeps the order paid when Stripe refuses the refund', async () => {
    await prepareSales();
    const event = await publish();
    const { order_id, session_id } = await buy(event.ticket_types[0]!.id);
    stripe.completeSession(session_id, { invoice: 'in_test_1' });
    stripe.requests.length = 0;

    // The first request reads the session, the second one creates the credit note.
    const original = stripe.fetch;
    let calls = 0;
    t.ctx.stripe = {
      fetch: (async (...args: Parameters<typeof fetch>) => {
        if (++calls === 2) stripe.failNext(400, 'Invoice is not paid', 'invalid_request_error');
        return original(...args);
      }) as typeof fetch,
    };
    try {
      const refund = await t.callTool('refund_order', { order_id });
      expect(refund.text).toContain('Stripe answered: Invoice is not paid');
      expect((await orderOf(order_id)).status).toBe('paid');
    } finally {
      t.ctx.stripe = { fetch: original };
    }
  });

  it('follows refunds made in the Stripe dashboard', async () => {
    await prepareSales();
    const event = await publish();
    const { order_id } = await buy(event.ticket_types[0]!.id);

    await webhook('charge.refunded', { id: 'ch_1', payment_intent: 'pi_test_1', refunded: false });
    expect((await orderOf(order_id)).status).toBe('paid');

    await webhook('charge.refunded', { id: 'ch_1', payment_intent: 'pi_test_1', refunded: true });
    expect((await orderOf(order_id)).status).toBe('refunded');
  });
});

describe('orders', () => {
  it('are listed per event with totals', async () => {
    await prepareSales();
    const first = await publish();
    const second = await publish({ title: 'Zweites Seminar' });
    await buy(first.ticket_types[0]!.id, 2, { amount_total: 98000 });
    await buy(first.ticket_types[1]!.id, 1, { amount_total: 29000 });
    await buy(second.ticket_types[0]!.id);
    await checkout({ ticket_type_id: first.ticket_types[0]!.id });

    const paid = (await t.callTool('list_orders', { event: first.slug })).data;
    expect(paid.totals).toEqual({
      orders: 2,
      paid_orders: 2,
      paid_tickets: 3,
      paid_amount_cents: 127000,
    });
    expect(paid.orders[0]).toMatchObject({
      event_title: first.title,
      customer_email: 'kundin@example.test',
      attendance: expect.any(String),
    });

    expect((await t.callTool('list_orders', { event: first.slug, status: 'all' })).data.totals.orders).toBe(3);
    expect((await t.callTool('list_orders', { status: 'pending' })).data.orders).toHaveLength(1);
    expect((await t.callTool('list_orders')).data.totals.paid_orders).toBe(3);
  });

  it('tell the thank-you page how the purchase went', async () => {
    await prepareSales();
    const event = await publish();
    const started = await checkout({ ticket_type_id: event.ticket_types[1]!.id });
    const sessionId = paidSession(started.body).id;
    const status = async (id: unknown) => {
      const response = await t.app.request(`/v1/orders/status?session_id=${id}`);
      return { status: response.status, body: (await response.json()) as any };
    };

    expect((await status(sessionId)).body).toMatchObject({ status: 'pending', customer_email: null });
    await webhook('checkout.session.completed', paidSession(started.body));

    const paid = await status(sessionId);
    expect(paid.body).toEqual({
      status: 'paid',
      quantity: 1,
      ticket_name: 'Online',
      attendance: 'online',
      customer_email: 'kundin@example.test',
      event: { slug: event.slug, title: event.title },
    });
    expect((await status('cs_test_unknown')).status).toBe(404);
    expect((await status("x' or 1=1")).status).toBe(404);
  });
});
