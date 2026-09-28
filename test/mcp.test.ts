import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { SmtpOptions } from '../src/domain/mail.ts';
import { createTestApp, daysFromNow } from './helpers.ts';
import type { TestApp } from './helpers.ts';

const sentMails: { options: SmtpOptions; message: any }[] = [];
let rejectMail = false;

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp({
    mailTransport: (options) => ({
      sendMail: async (message: any) => {
        if (rejectMail) throw new Error('535 Authentication failed');
        sentMails.push({ options, message });
        return { messageId: '<test@example.test>' } as any;
      },
    }),
  });
});
beforeEach(async () => {
  sentMails.length = 0;
  rejectMail = false;
  await t.reset();
});
afterAll(() => t.close());

const newEvent = () => ({
  title: 'Prompting Workshop',
  format: 'online',
  starts_at: daysFromNow(20).toISOString(),
  ends_at: daysFromNow(20, 3).toISOString(),
  online_url: 'https://meet.example.test/workshop',
  ticket_types: [{ name: 'Teilnahme', attendance: 'online', price_cents: 19000, capacity: 50 }],
});

describe('access', () => {
  it('rejects calls without the admin token', async () => {
    expect((await t.rpc('tools/list', {}, null)).status).toBe(401);
    expect((await t.rpc('tools/list', {}, 'wrong-token')).status).toBe(401);
  });

  it('accepts only POST', async () => {
    const response = await t.app.request('/mcp', {
      headers: { authorization: `Bearer ${t.ctx.config.adminToken}` },
    });
    expect(response.status).toBe(405);
  });

  it('answers the MCP handshake', async () => {
    const response = await t.rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0.0' },
    });
    const body = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(body.result.serverInfo.name).toBe('event-backend');
    expect(body.result.instructions).toContain('draft');
  });

  it('offers the expected tools', async () => {
    const body = (await (await t.rpc('tools/list', {})).json()) as any;
    expect(body.result.tools.map((tool: any) => tool.name).sort()).toEqual([
      'add_ticket_type',
      'create_event',
      'create_stripe_webhook',
      'create_thumbnail_upload',
      'delete_event',
      'duplicate_event',
      'get_event',
      'get_order',
      'get_settings',
      'get_stripe_status',
      'list_events',
      'list_orders',
      'refund_order',
      'remove_event_thumbnail',
      'remove_ticket_type',
      'resend_confirmation',
      'resend_confirmations',
      'send_test_email',
      'set_event_status',
      'set_event_thumbnail_from_url',
      'update_event',
      'update_mail_settings',
      'update_settings',
      'update_stripe_settings',
      'update_ticket_type',
    ]);
  });
});

describe('managing events', () => {
  it('takes an event from draft to the website', async () => {
    const created = await t.callTool('create_event', newEvent());
    expect(created.data).toMatchObject({
      status: 'draft',
      slug: 'prompting-workshop',
      online_url: 'https://meet.example.test/workshop',
    });
    expect((await t.app.request('/v1/events/prompting-workshop')).status).toBe(404);

    const published = await t.callTool('set_event_status', {
      event: 'prompting-workshop',
      status: 'published',
    });
    expect(published.data.event.status).toBe('published');

    const website = (await (await t.app.request('/v1/events/prompting-workshop')).json()) as any;
    expect(website.event.tickets[0]).toMatchObject({ name: 'Teilnahme', price_cents: 19000 });
  });

  it('updates single fields and keeps the rest', async () => {
    await t.callTool('create_event', newEvent());
    const updated = await t.callTool('update_event', {
      event: 'prompting-workshop',
      summary: 'Kompakt an einem Vormittag',
      starts_at: daysFromNow(21).toISOString(),
      ends_at: daysFromNow(21, 3).toISOString(),
    });
    expect(updated.data.warnings).toEqual([]);
    expect(updated.data.event).toMatchObject({
      title: 'Prompting Workshop',
      summary: 'Kompakt an einem Vormittag',
      online_url: 'https://meet.example.test/workshop',
    });
  });

  it('manages ticket types', async () => {
    const created = await t.callTool('create_event', newEvent());
    const added = await t.callTool('add_ticket_type', {
      event: created.data.id,
      name: 'Team (3 Personen)',
      attendance: 'online',
      price_cents: 45000,
      sales_end: daysFromNow(10).toISOString(),
    });
    expect(added.data.ticket_types).toHaveLength(2);

    const team = added.data.ticket_types[1];
    expect(team).toMatchObject({ capacity: null, available: null, sold: 0 });

    const changed = await t.callTool('update_ticket_type', {
      ticket_type_id: team.id,
      capacity: 5,
      sales_end: null,
    });
    expect(changed.data.ticket_types[1]).toMatchObject({ capacity: 5, sales_end: null });

    const removed = await t.callTool('remove_ticket_type', { ticket_type_id: team.id });
    expect(removed.data.ticket_types).toHaveLength(1);
  });

  it('lists events by status', async () => {
    await t.callTool('create_event', newEvent());
    await t.callTool('create_event', { ...newEvent(), title: 'Zweiter Workshop' });
    await t.callTool('set_event_status', { event: 'zweiter-workshop', status: 'published' });

    const drafts = await t.callTool('list_events', { status: 'draft' });
    expect(drafts.data.events.map((event: any) => event.slug)).toEqual(['prompting-workshop']);
    expect((await t.callTool('list_events')).data.events).toHaveLength(2);
  });

  it('reports problems as tool errors', async () => {
    const missing = await t.callTool('get_event', { event: 'unknown' });
    expect(missing).toMatchObject({ isError: true });
    expect(missing.text).toContain('not_found');

    const mismatch = await t.callTool('create_event', {
      ...newEvent(),
      ticket_types: [{ name: 'Vor Ort', attendance: 'onsite', price_cents: 1000 }],
    });
    expect(mismatch.text).toContain('does not fit');
  });

  it('rejects malformed input before it reaches the database', async () => {
    const response = await t.rpc('tools/call', {
      name: 'create_event',
      arguments: { ...newEvent(), starts_at: 'next tuesday' },
    });
    const body = (await response.json()) as any;
    expect(body.error ?? body.result.isError).toBeTruthy();
    expect((await t.callTool('list_events')).data.events).toHaveLength(0);
  });
});

describe('settings', () => {
  it('stores general settings', async () => {
    const updated = await t.callTool('update_settings', {
      organizer_name: 'Beispiel Akademie',
      allowed_origins: ['https://www.example.com'],
      low_stock_threshold: 5,
    });
    expect(updated.data.general).toMatchObject({
      organizer_name: 'Beispiel Akademie',
      allowed_origins: ['https://www.example.com'],
      low_stock_threshold: 5,
      terms_url: null,
    });

    const invalid = await t.callTool('update_settings', {
      allowed_origins: ['https://www.example.com/path'],
    });
    expect(invalid.isError).toBe(true);
  });

  it('never returns the SMTP password and stores it encrypted', async () => {
    const updated = await t.callTool('update_mail_settings', {
      host: 'smtp.example.test',
      username: 'events@example.test',
      password: 'correct horse battery staple',
      from_name: 'Beispiel Akademie',
      from_email: 'events@example.test',
    });
    expect(updated.data.mail).toMatchObject({
      host: 'smtp.example.test',
      port: 587,
      security: 'starttls',
      password_set: true,
      password_source: 'database',
      ready: true,
    });
    expect(updated.text).not.toContain('correct horse');

    const settings = await t.callTool('get_settings');
    expect(settings.text).not.toContain('correct horse');
    expect(settings.text).not.toContain('password_encrypted');

    const [row] = await t.db.query<{ value: unknown }>("select value from settings where key = 'mail'");
    expect(JSON.stringify(row?.value)).not.toContain('correct horse');
  });

  it('sends a test mail with the stored credentials', async () => {
    await t.callTool('update_mail_settings', {
      host: 'smtp.example.test',
      username: 'events@example.test',
      password: 'correct horse battery staple',
      from_name: 'Beispiel Akademie',
      from_email: 'events@example.test',
      reply_to: 'kontakt@example.test',
    });
    // Changing another field must keep the password.
    await t.callTool('update_mail_settings', { port: 465, security: 'tls' });

    const result = await t.callTool('send_test_email', { to: 'someone@example.test' });
    expect(result.data).toMatchObject({ sent: true, to: 'someone@example.test' });
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]!.options).toMatchObject({
      host: 'smtp.example.test',
      port: 465,
      secure: true,
      auth: { user: 'events@example.test', pass: 'correct horse battery staple' },
    });
    expect(sentMails[0]!.message).toMatchObject({
      to: 'someone@example.test',
      from: { name: 'Beispiel Akademie', address: 'events@example.test' },
      replyTo: 'kontakt@example.test',
    });
  });

  it('explains what is missing or what the mail server answered', async () => {
    const unconfigured = await t.callTool('send_test_email', { to: 'someone@example.test' });
    expect(unconfigured.text).toContain('No sender address');

    await t.callTool('update_mail_settings', {
      host: 'smtp.example.test',
      from_email: 'events@example.test',
    });
    rejectMail = true;
    const rejected = await t.callTool('send_test_email', { to: 'someone@example.test' });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain('535 Authentication failed');
  });
});
