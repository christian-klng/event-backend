// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const API = 'https://events.example.test';
const source = readFileSync(join(import.meta.dirname, '../public/embed.js'), 'utf8');

type Handler = (url: URL, init?: RequestInit) => { status?: number; body: unknown };
let handler: Handler;
const calls: { url: URL; init: RequestInit | undefined }[] = [];
const redirect = vi.fn();

const ticket = (overrides: Record<string, unknown> = {}) => ({
  id: 'ticket-onsite',
  name: 'Präsenz',
  description: 'Inklusive Mittagessen',
  attendance: 'onsite',
  price_cents: 49000,
  currency: 'eur',
  max_per_order: 4,
  sales_start: null,
  sales_end: '2030-11-05T08:00:00.000Z',
  on_sale: true,
  sold_out: false,
  remaining: null,
  ...overrides,
});

const event = (overrides: Record<string, unknown> = {}) => ({
  id: 'event-1',
  slug: 'ki-seminar',
  status: 'published',
  title: 'KI für Führungskräfte',
  summary: 'Ein Tag voller Praxis.',
  description_html: '<p>Mit <strong>Praxis</strong>.</p>',
  format: 'hybrid',
  starts_at: '2030-11-05T08:00:00.000Z',
  ends_at: '2030-11-05T16:00:00.000Z',
  timezone: 'Europe/Berlin',
  location: { name: 'Seminarhaus', address: 'Beispielweg 1, 10115 Berlin' },
  thumbnail: { large: `${API}/media/abc/large.webp`, small: `${API}/media/abc/small.webp`, width: 1600, height: 800 },
  price_from_cents: 29000,
  currency: 'eur',
  tax_percent: 19,
  bookable: true,
  sold_out: false,
  tickets: [ticket(), ticket({ id: 'ticket-online', name: 'Online', attendance: 'online', price_cents: 29000, description: '' })],
  ...overrides,
});

function serve(events: ReturnType<typeof event>[], extra: Handler = () => ({ status: 404, body: {} })): Handler {
  return (url, init) => {
    if (url.pathname === '/v1/events') return { body: { events } };
    const found = events.find((candidate) => url.pathname === `/v1/events/${candidate.slug}`);
    if (found) return { body: { event: found } };
    if (url.pathname.startsWith('/v1/events/')) {
      return { status: 404, body: { error: 'not_found', message: 'Event not found' } };
    }
    return extra(url, init);
  };
}

async function mount(html: string): Promise<HTMLElement> {
  document.body.innerHTML = html;
  return document.body.firstElementChild as HTMLElement;
}

/** Prices contain non-breaking spaces. */
const plain = (element: Element | null) => element!.textContent!.replace(/\u00a0/g, ' ');

const settled = (check: () => void) => vi.waitFor(check, { timeout: 2000, interval: 10 });

beforeAll(() => {
  (window as any).eventWidgetConfig = { api: API };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, init });
      const { status = 200, body } = handler(url, init);
      return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    }),
  );
  Object.defineProperty(window.location, 'assign', { value: redirect, configurable: true });
  window.eval(source);
});

beforeEach(() => {
  calls.length = 0;
  redirect.mockClear();
  handler = serve([event()]);
});

afterEach(() => {
  document.querySelector<HTMLDialogElement>('dialog.ev-dialog')?.close();
  document.body.innerHTML = '';
  history.replaceState(null, '', location.pathname);
});

describe('<event-list>', () => {
  it('shows events as cards', async () => {
    handler = serve([
      event(),
      event({ slug: 'ausgebucht', title: 'Ausgebuchtes Seminar', sold_out: true, bookable: false, format: 'online', location: null, thumbnail: null }),
    ]);
    const list = await mount('<event-list></event-list>');
    await settled(() => expect(list.querySelectorAll('.ev-card')).toHaveLength(2));

    const [first, second] = list.querySelectorAll('.ev-card');
    expect(first!.querySelector('.ev-card__title')!.textContent).toBe('KI für Führungskräfte');
    expect(first!.querySelector('.ev-card__title')!.tagName).toBe('H3');
    expect(first!.querySelector('.ev-card__date')!.textContent).toBe('Di., 5. Nov. 2030 · 09:00–17:00 Uhr');
    expect(plain(first!.querySelector('.ev-card__price'))).toBe('ab 290,00 €');
    expect(first!.querySelector('.ev-badge')!.textContent).toBe('Präsenz und online');
    expect(first!.querySelector('.ev-meta__place')!.textContent).toBe('Seminarhaus');
    expect(first!.querySelector('img')!.getAttribute('src')).toBe(`${API}/media/abc/small.webp`);
    expect(first!.querySelector('a')!.getAttribute('href')).toBe('#event/ki-seminar');

    expect(second!.querySelector('.ev-card__note')!.textContent).toBe('Ausgebucht');
    expect(second!.querySelector('.ev-card__price')).toBeNull();
    expect(second!.querySelector('img')).toBeNull();
    expect(calls[0]!.url.href).toBe(`${API}/v1/events?when=upcoming`);
  });

  it('treats everything from the server as text', async () => {
    handler = serve([event({ title: '<img src=x onerror=alert(1)>', summary: '<script>alert(1)</script>' })]);
    const list = await mount('<event-list></event-list>');
    await settled(() => expect(list.querySelector('.ev-card')).not.toBeNull());

    expect(list.querySelector('.ev-card__title')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(list.querySelector('.ev-card__title img')).toBeNull();
    expect(list.querySelector('script')).toBeNull();
  });

  it('filters, limits and adapts to the page', async () => {
    handler = serve([
      event({ slug: 'a', format: 'online' }),
      event({ slug: 'b', format: 'onsite' }),
      event({ slug: 'c', format: 'hybrid' }),
      event({ slug: 'd', format: 'online' }),
    ]);
    const list = await mount('<event-list when="all" format="online" limit="2" heading-level="2"></event-list>');
    await settled(() => expect(list.querySelectorAll('.ev-card')).toHaveLength(2));

    expect([...list.querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual(['#event/a', '#event/c']);
    expect(list.querySelector('.ev-card__title')!.tagName).toBe('H2');
    expect(calls[0]!.url.searchParams.get('when')).toBe('all');

    list.setAttribute('limit', '1');
    await settled(() => expect(list.querySelectorAll('.ev-card')).toHaveLength(1));
  });

  it('says so when there are no events', async () => {
    handler = serve([]);
    const list = await mount('<event-list></event-list>');
    await settled(() => expect(list.textContent).toContain('Aktuell sind keine Veranstaltungen geplant.'));

    const custom = await mount('<event-list empty-text="Bald geht es weiter."></event-list>');
    await settled(() => expect(custom.textContent).toContain('Bald geht es weiter.'));
  });

  it('offers to try again when loading fails', async () => {
    handler = () => ({ status: 500, body: { error: 'internal' } });
    const list = await mount('<event-list></event-list>');
    await settled(() => expect(list.querySelector('[role="alert"]')).not.toBeNull());

    handler = serve([event()]);
    list.querySelector<HTMLButtonElement>('button')!.click();
    await settled(() => expect(list.querySelectorAll('.ev-card')).toHaveLength(1));
  });
});

describe('event dialog', () => {
  async function openDetail() {
    await mount('<event-list></event-list>');
    location.hash = '#event/ki-seminar';
    window.dispatchEvent(new Event('hashchange'));
    await settled(() => expect(document.querySelector('.ev-dialog .ev-detail')).not.toBeNull());
    return document.querySelector<HTMLDialogElement>('dialog.ev-dialog')!;
  }

  it('shows the event with its tickets', async () => {
    const dialog = await openDetail();
    expect(dialog.open).toBe(true);
    expect(dialog.querySelector('.ev-detail__title')!.textContent).toBe('KI für Führungskräfte');
    expect(dialog.querySelector('.ev-detail__date')!.textContent).toBe('Dienstag, 5. November 2030 · 09:00–17:00 Uhr');
    expect(dialog.querySelector('.ev-detail__description strong')!.textContent).toBe('Praxis');
    expect(dialog.querySelector('.ev-detail__address')!.textContent).toBe('Beispielweg 1, 10115 Berlin');

    const tickets = dialog.querySelectorAll('.ev-ticket');
    expect(tickets).toHaveLength(2);
    expect(tickets[0]!.querySelector('.ev-ticket__name')!.textContent).toBe('Präsenz');
    expect(plain(tickets[0]!.querySelector('.ev-ticket__price'))).toBe('490,00 € inkl. USt.');
    expect(tickets[0]!.querySelectorAll('option')).toHaveLength(4);
  });

  it('opens directly from a link to the event', async () => {
    history.replaceState(null, '', '#event/ki-seminar');
    await mount('<event-list></event-list>');
    await settled(() => expect(document.querySelector('.ev-dialog .ev-detail')).not.toBeNull());
  });

  it('clears the address when it closes', async () => {
    const dialog = await openDetail();
    dialog.close();
    dialog.dispatchEvent(new Event('close'));
    expect(location.hash).toBe('');
  });

  it('explains tickets that cannot be bought', async () => {
    handler = serve([
      event({
        tickets: [
          ticket({ id: 'a', remaining: 3 }),
          ticket({ id: 'b', remaining: 1 }),
          ticket({ id: 'c', sold_out: true, on_sale: false, remaining: 0 }),
          ticket({ id: 'd', on_sale: false, sales_start: '2999-01-01T00:00:00.000Z' }),
          ticket({ id: 'e', on_sale: false }),
        ],
      }),
    ]);
    const dialog = await openDetail();
    const hints = [...dialog.querySelectorAll('.ev-ticket')].map((form) => ({
      hint: form.querySelector('.ev-ticket__hint')?.textContent,
      button: form.querySelector('button') !== null,
    }));
    expect(hints).toEqual([
      { hint: 'Nur noch 3 Plätze frei', button: true },
      { hint: 'Nur noch 1 Platz frei', button: true },
      { hint: 'Ausgebucht', button: false },
      { hint: expect.stringContaining('Buchbar ab'), button: false },
      { hint: 'Buchung beendet', button: false },
    ]);
  });

  it('mentions tax only when prices contain it', async () => {
    handler = serve([event({ tax_percent: 0 })]);
    const exempt = await openDetail();
    expect(plain(exempt.querySelector('.ev-ticket__price'))).toBe('490,00 €');
    exempt.close();

    handler = serve([event({ tax_percent: null })]);
    const undecided = await openDetail();
    expect(plain(undecided.querySelector('.ev-ticket__price'))).toBe('490,00 €');
  });

  it('hides tickets of cancelled events', async () => {
    handler = serve([event({ status: 'cancelled', bookable: false })]);
    const dialog = await openDetail();
    expect(dialog.querySelector('.ev-detail__note')!.textContent).toBe('Abgesagt');
    expect(dialog.querySelector('.ev-tickets')).toBeNull();
  });

  it('reports events that do not exist', async () => {
    await mount('<event-list></event-list>');
    location.hash = '#event/unknown';
    window.dispatchEvent(new Event('hashchange'));
    await settled(() =>
      expect(document.querySelector('.ev-dialog')!.textContent).toContain('Diese Veranstaltung wurde nicht gefunden.'),
    );
  });

  it('sends buyers to the payment page', async () => {
    handler = serve([event()], (url) =>
      url.pathname === '/v1/checkout'
        ? { status: 201, body: { checkout_url: 'https://checkout.stripe.com/c/pay/cs_test_1', order_id: 'o1' } }
        : { status: 404, body: {} },
    );
    const dialog = await openDetail();
    const form = dialog.querySelector<HTMLFormElement>('.ev-ticket')!;
    form.querySelector<HTMLSelectElement>('select')!.value = '3';
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    await settled(() => expect(redirect).toHaveBeenCalledWith('https://checkout.stripe.com/c/pay/cs_test_1'));
    const request = calls.find((call) => call.url.pathname === '/v1/checkout')!;
    expect(request.init).toMatchObject({ method: 'POST' });
    expect(JSON.parse(String(request.init!.body))).toEqual({ ticket_type_id: 'ticket-onsite', quantity: 3 });
    expect(form.querySelector('button')!.disabled).toBe(true);
  });

  it.each([
    ['sold_out', 409, 'Dieses Ticket ist inzwischen ausgebucht.'],
    ['not_enough_seats', 409, 'So viele Plätze sind nicht mehr frei. Bitte wählen Sie eine kleinere Anzahl.'],
    ['not_on_sale', 409, 'Dieses Ticket ist derzeit nicht buchbar.'],
    ['not_configured', 503, 'Die Buchung ist im Moment nicht möglich. Bitte versuchen Sie es später erneut.'],
  ])('explains a failed purchase (%s)', async (reason, status, expected) => {
    handler = serve([event()], () => ({ status, body: { error: 'conflict', reason, message: 'english text' } }));
    const dialog = await openDetail();
    const form = dialog.querySelector<HTMLFormElement>('.ev-ticket')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));

    const error = form.querySelector<HTMLElement>('.ev-ticket__error')!;
    await settled(() => expect(error.hidden).toBe(false));
    expect(error.textContent).toBe(expected);
    expect(form.querySelector('button')!.disabled).toBe(false);
    expect(form.querySelector('button')!.textContent).toBe('Jetzt buchen');
    expect(redirect).not.toHaveBeenCalled();
  });

  it('explains the limit on attempts', async () => {
    handler = serve([event()], () => ({ status: 429, body: { error: 'rate_limited', message: 'Too many attempts.' } }));
    const dialog = await openDetail();
    const form = dialog.querySelector<HTMLFormElement>('.ev-ticket')!;
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await settled(() => expect(form.querySelector('.ev-ticket__error')!.textContent).toContain('Zu viele Versuche'));
  });
});

describe('<event-detail>', () => {
  it('shows one event inside the page', async () => {
    const detail = await mount('<event-detail slug="ki-seminar" heading-level="2"></event-detail>');
    await settled(() => expect(detail.querySelector('.ev-detail')).not.toBeNull());
    expect(detail.querySelector('.ev-detail__title')!.tagName).toBe('H1');
    expect(detail.querySelectorAll('.ev-ticket')).toHaveLength(2);
    expect(document.querySelector('dialog')).toBeNull();
  });
});

describe('<event-order-status>', () => {
  const order = (status: string, email: string | null = 'kundin@example.test') => ({
    status,
    quantity: 2,
    ticket_name: 'Online',
    attendance: 'online',
    customer_email: email,
    event: { slug: 'ki-seminar', title: 'KI für Führungskräfte' },
  });

  it('waits for the payment and confirms it', async () => {
    let answers = 0;
    handler = (url) => {
      expect(url.searchParams.get('session_id')).toBe('cs_test_1');
      return { body: ++answers < 3 ? order('pending', null) : order('paid') };
    };
    const status = await mount('<event-order-status session-id="cs_test_1" interval="10"></event-order-status>');
    await settled(() => expect(status.dataset.status).toBe('checking'));
    expect(status.textContent).toContain('Ihre Zahlung wird bestätigt');

    await settled(() => expect(status.dataset.status).toBe('paid'));
    expect(answers).toBe(3);
    expect(status.querySelector('.ev-status__title')!.textContent).toBe('Vielen Dank für Ihre Buchung!');
    expect(status.textContent).toContain('„KI für Führungskräfte“ ist bestätigt (2 × Online)');
    expect(status.textContent).toContain('an kundin@example.test gesendet');
  });

  it('reads the session from the address of the page', async () => {
    history.replaceState(null, '', '?session_id=cs_test_from_url');
    handler = () => ({ body: order('paid') });
    const status = await mount('<event-order-status></event-order-status>');
    await settled(() => expect(status.dataset.status).toBe('paid'));
    expect(calls[0]!.url.searchParams.get('session_id')).toBe('cs_test_from_url');
    history.replaceState(null, '', location.pathname);
  });

  it('stays calm when the confirmation takes long', async () => {
    handler = () => ({ body: order('pending', null) });
    const status = await mount(
      '<event-order-status session-id="cs_test_1" interval="5" max-attempts="3"></event-order-status>',
    );
    await settled(() => expect(status.dataset.status).toBe('slow'));
    expect(status.textContent).toContain('Sobald die Zahlung bestätigt ist, erhalten Sie eine E-Mail.');
    expect(calls).toHaveLength(3);
  });

  it.each([
    ['expired', 'failed', 'Die Buchung wurde nicht abgeschlossen'],
    ['cancelled', 'failed', 'Die Buchung wurde nicht abgeschlossen'],
    ['refunded', 'refunded', 'Diese Buchung wurde erstattet'],
  ])('explains an order that is %s', async (orderStatus, kind, title) => {
    handler = () => ({ body: order(orderStatus) });
    const status = await mount('<event-order-status session-id="cs_test_1"></event-order-status>');
    await settled(() => expect(status.dataset.status).toBe(kind));
    expect(status.querySelector('.ev-status__title')!.textContent).toBe(title);
  });

  it('reports links without a purchase', async () => {
    handler = () => ({ status: 404, body: { error: 'not_found' } });
    const unknown = await mount('<event-order-status session-id="cs_test_x"></event-order-status>');
    await settled(() => expect(unknown.dataset.status).toBe('unknown'));

    calls.length = 0;
    const missing = await mount('<event-order-status></event-order-status>');
    await settled(() => expect(missing.dataset.status).toBe('unknown'));
    expect(calls).toHaveLength(0);
  });
});

describe('styles', () => {
  it('never override the website', () => {
    const style = document.head.querySelector('style[data-event-widgets]')!;
    expect(document.head.firstElementChild).toBe(style);
    // Selectors inside :where() have no specificity, so any rule of the website wins.
    const selectors = style.textContent!
      .replace(/@media[^{]+\{/g, '')
      .split('}')
      .map((rule) => rule.split('{')[0]!.trim())
      .filter(Boolean);
    expect(selectors.length).toBeGreaterThan(40);
    for (const selector of selectors) expect(selector, selector).toMatch(/^:where\(/);
  });
});
