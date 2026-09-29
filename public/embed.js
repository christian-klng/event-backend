/*
 * Event widgets for websites.
 *
 *   <script src="https://events.example.com/embed.js" defer></script>
 *   <event-list></event-list>            list of events, details open in a dialog
 *   <event-detail slug="..."></event-detail>   one event on its own page
 *   <event-order-status></event-order-status>  result of a purchase, for the thank-you page
 *
 * Everything renders into the page itself (no shadow DOM), so the website's CSS applies.
 * The built-in styles have no specificity and lose against any rule of the website.
 */
(() => {
  'use strict';
  if (customElements.get('event-list')) return;

  const script = document.currentScript;
  const config = window.eventWidgetConfig ?? {};
  const API = (config.api ?? (script ? new URL(script.src).origin : location.origin)).replace(/\/+$/, '');
  const LOCALE = config.locale ?? 'de-DE';
  const HASH_PREFIX = '#event/';

  const TEXTS = {
    loading: 'Veranstaltungen werden geladen …',
    empty: 'Aktuell sind keine Veranstaltungen geplant.',
    loadError: 'Die Veranstaltungen konnten nicht geladen werden. Bitte versuchen Sie es später erneut.',
    notFound: 'Diese Veranstaltung wurde nicht gefunden.',
    retry: 'Erneut versuchen',
    close: 'Schließen',
    online: 'Online',
    onsite: 'Präsenz',
    hybrid: 'Präsenz und online',
    priceFrom: 'ab {price}',
    soldOut: 'Ausgebucht',
    cancelled: 'Abgesagt',
    past: 'Bereits beendet',
    details: 'Details und Buchung',
    tickets: 'Tickets',
    inclTax: 'inkl. USt.',
    quantity: 'Anzahl',
    buy: 'Jetzt buchen',
    buying: 'Einen Moment …',
    remaining: 'Nur noch {count} Plätze frei',
    remainingOne: 'Nur noch 1 Platz frei',
    salesStart: 'Buchbar ab {date}',
    salesEnded: 'Buchung beendet',
    noTickets: 'Für diese Veranstaltung sind derzeit keine Tickets buchbar.',
    paymentNote: 'Die Bezahlung erfolgt sicher über unseren Zahlungsdienstleister Stripe.',
    errorSoldOut: 'Dieses Ticket ist inzwischen ausgebucht.',
    errorSeats: 'So viele Plätze sind nicht mehr frei. Bitte wählen Sie eine kleinere Anzahl.',
    errorNotOnSale: 'Dieses Ticket ist derzeit nicht buchbar.',
    errorQuantity: 'Diese Anzahl kann nicht auf einmal gebucht werden.',
    errorRateLimit: 'Zu viele Versuche. Bitte versuchen Sie es in einigen Minuten erneut.',
    errorUnavailable: 'Die Buchung ist im Moment nicht möglich. Bitte versuchen Sie es später erneut.',
    statusChecking: 'Ihre Zahlung wird bestätigt …',
    statusPaidTitle: 'Vielen Dank für Ihre Buchung!',
    statusPaid: 'Ihre Anmeldung für „{event}“ ist bestätigt ({tickets}).',
    statusMail: 'Die Bestätigung mit allen Details haben wir an {email} gesendet.',
    statusMailGeneric: 'Die Bestätigung mit allen Details erhalten Sie per E-Mail.',
    statusSlowTitle: 'Ihre Zahlung wird noch verarbeitet',
    statusSlow: 'Das kann einen Moment dauern. Sobald die Zahlung bestätigt ist, erhalten Sie eine E-Mail.',
    statusFailedTitle: 'Die Buchung wurde nicht abgeschlossen',
    statusFailed: 'Es wurde nichts berechnet. Sie können die Buchung jederzeit erneut starten.',
    statusRefundedTitle: 'Diese Buchung wurde erstattet',
    statusUnknownTitle: 'Keine Buchung gefunden',
    statusUnknown: 'Zu diesem Link liegt uns keine Buchung vor.',
    ...config.texts,
  };

  const text = (key, values = {}) =>
    TEXTS[key].replace(/\{(\w+)\}/g, (match, name) => (name in values ? values[name] : match));

  // Building blocks ---------------------------------------------------------------------------

  /** Creates an element. Text always goes in as text, never as markup. */
  function h(tag, props = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
      if (value === null || value === undefined || value === false) continue;
      if (name === 'class') element.className = value;
      else if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
      else element.setAttribute(name, value === true ? '' : String(value));
    }
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      element.append(child instanceof Node ? child : String(child));
    }
    return element;
  }

  async function api(path, options) {
    const response = await fetch(`${API}${path}`, options);
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw Object.assign(new Error(body.message ?? `HTTP ${response.status}`), {
        status: response.status,
        reason: body.reason ?? body.error,
      });
    }
    return body;
  }

  const money = (cents, currency) =>
    new Intl.NumberFormat(LOCALE, { style: 'currency', currency: (currency ?? 'eur').toUpperCase() }).format(
      cents / 100,
    );

  function formatDay(date, timeZone, style) {
    return new Intl.DateTimeFormat(LOCALE, {
      timeZone,
      weekday: style === 'long' ? 'long' : 'short',
      day: 'numeric',
      month: style === 'long' ? 'long' : 'short',
      year: 'numeric',
    }).format(date);
  }

  const formatTime = (date, timeZone) =>
    new Intl.DateTimeFormat(LOCALE, { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

  function formatWhen(event, style = 'short') {
    const start = new Date(event.starts_at);
    const end = new Date(event.ends_at);
    const zone = event.timezone;
    if (formatDay(start, zone) === formatDay(end, zone)) {
      return `${formatDay(start, zone, style)} · ${formatTime(start, zone)}–${formatTime(end, zone)} Uhr`;
    }
    return `${formatDay(start, zone, style)}, ${formatTime(start, zone)} Uhr – ${formatDay(end, zone, style)}, ${formatTime(end, zone)} Uhr`;
  }

  const isPast = (event) => new Date(event.ends_at) < new Date();

  /** What to show instead of a price when an event cannot be booked. */
  function availabilityNote(event) {
    if (event.status === 'cancelled') return text('cancelled');
    if (isPast(event)) return text('past');
    if (event.sold_out) return text('soldOut');
    return null;
  }

  function headingTag(host, offset = 0) {
    const level = Number(host.getAttribute('heading-level')) || 3;
    return `h${Math.min(6, Math.max(1, level + offset))}`;
  }

  function message(kind, content, action) {
    return h('div', { class: `ev-message ev-message--${kind}`, role: kind === 'error' ? 'alert' : 'status' },
      h('p', {}, content),
      action,
    );
  }

  // Rendering ---------------------------------------------------------------------------------

  function renderMeta(event) {
    const place = event.location?.name || event.location?.address;
    return h('p', { class: 'ev-meta' },
      h('span', { class: `ev-badge ev-badge--${event.format}` }, text(event.format)),
      place && h('span', { class: 'ev-meta__place' }, place),
    );
  }

  function renderCard(event, host) {
    const note = availabilityNote(event);
    return h('li', { class: 'ev-card', 'data-format': event.format, 'data-status': event.status, 'data-bookable': String(event.bookable) },
      h('a', { class: 'ev-card__link', href: `${HASH_PREFIX}${event.slug}`, 'aria-label': `${event.title} – ${text('details')}` },
        event.thumbnail &&
          h('img', {
            class: 'ev-card__image',
            src: event.thumbnail.small,
            width: event.thumbnail.width,
            height: event.thumbnail.height,
            alt: '',
            loading: 'lazy',
          }),
        h('div', { class: 'ev-card__body' },
          h('p', { class: 'ev-card__date' }, formatWhen(event)),
          h(headingTag(host), { class: 'ev-card__title' }, event.title),
          event.summary && h('p', { class: 'ev-card__summary' }, event.summary),
          renderMeta(event),
          note
            ? h('p', { class: 'ev-card__note' }, note)
            : event.price_from_cents !== null &&
                h('p', { class: 'ev-card__price' },
                  event.tickets.length > 1
                    ? text('priceFrom', { price: money(event.price_from_cents, event.currency) })
                    : money(event.price_from_cents, event.currency),
                ),
        ),
      ),
    );
  }

  function ticketHint(ticket) {
    if (ticket.sold_out) return text('soldOut');
    if (ticket.sales_start && new Date(ticket.sales_start) > new Date()) {
      return text('salesStart', { date: formatDay(new Date(ticket.sales_start), undefined, 'long') });
    }
    if (!ticket.on_sale) return text('salesEnded');
    if (ticket.remaining === 1) return text('remainingOne');
    if (ticket.remaining !== null) return text('remaining', { count: ticket.remaining });
    return null;
  }

  function renderTicket(ticket, host, event) {
    const error = h('p', { class: 'ev-ticket__error', role: 'alert', hidden: true });
    const quantityId = `ev-quantity-${ticket.id}`;
    const quantity = h('select', { class: 'ev-ticket__quantity', id: quantityId, name: 'quantity' },
      Array.from({ length: Math.max(1, Math.min(10, ticket.max_per_order)) }, (_, index) =>
        h('option', { value: index + 1 }, index + 1),
      ),
    );
    const button = h('button', { class: 'ev-button', type: 'submit' }, text('buy'));
    const hint = ticketHint(ticket);

    async function buy(submit) {
      submit.preventDefault();
      error.hidden = true;
      button.disabled = true;
      button.textContent = text('buying');
      try {
        const checkout = await api('/v1/checkout', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ticket_type_id: ticket.id, quantity: Number(quantity.value) }),
        });
        host.dispatchEvent(new CustomEvent('event-checkout', { bubbles: true, detail: { ticket, checkout } }));
        location.assign(checkout.checkout_url);
      } catch (err) {
        const key =
          {
            sold_out: 'errorSoldOut',
            not_enough_seats: 'errorSeats',
            not_on_sale: 'errorNotOnSale',
            quantity: 'errorQuantity',
            rate_limited: 'errorRateLimit',
          }[err.reason] ?? 'errorUnavailable';
        error.textContent = text(key);
        error.hidden = false;
        button.disabled = false;
        button.textContent = text('buy');
      }
    }

    return h('form', { class: 'ev-ticket', 'data-attendance': ticket.attendance, 'data-on-sale': String(ticket.on_sale), onsubmit: buy },
      h('div', { class: 'ev-ticket__info' },
        h('p', { class: 'ev-ticket__name' }, ticket.name),
        ticket.description && h('p', { class: 'ev-ticket__description' }, ticket.description),
        hint && h('p', { class: 'ev-ticket__hint' }, hint),
      ),
      h('p', { class: 'ev-ticket__price' },
        money(ticket.price_cents, ticket.currency),
        event.tax_percent > 0 && h('small', { class: 'ev-ticket__tax' }, ` ${text('inclTax')}`),
      ),
      ticket.on_sale &&
        h('div', { class: 'ev-ticket__action' },
          h('label', { class: 'ev-ticket__label', for: quantityId }, text('quantity')),
          quantity,
          button,
        ),
      error,
    );
  }

  function renderDetail(event, host) {
    const note = availabilityNote(event);
    // The description is HTML made from Markdown on the server, with raw HTML switched off.
    const description = h('div', { class: 'ev-detail__description' });
    description.innerHTML = event.description_html ?? '';

    return h('article', { class: 'ev-detail', 'data-format': event.format, 'data-status': event.status },
      event.thumbnail &&
        h('img', {
          class: 'ev-detail__image',
          src: event.thumbnail.large,
          width: event.thumbnail.width,
          height: event.thumbnail.height,
          alt: '',
        }),
      h('header', { class: 'ev-detail__header' },
        h('p', { class: 'ev-detail__date' }, formatWhen(event, 'long')),
        h(headingTag(host, -1), { class: 'ev-detail__title', id: 'ev-detail-title' }, event.title),
        renderMeta(event),
        event.location?.address && h('p', { class: 'ev-detail__address' }, event.location.address),
        note && h('p', { class: 'ev-detail__note' }, note),
      ),
      description,
      !note &&
        h('section', { class: 'ev-tickets' },
          h(headingTag(host), { class: 'ev-tickets__title' }, text('tickets')),
          event.tickets.length > 0
            ? event.tickets.map((ticket) => renderTicket(ticket, host, event))
            : h('p', {}, text('noTickets')),
          event.bookable && h('p', { class: 'ev-tickets__note' }, text('paymentNote')),
        ),
    );
  }

  async function loadDetail(container, slug, host) {
    container.replaceChildren(message('info', text('loading')));
    try {
      const { event } = await api(`/v1/events/${encodeURIComponent(slug)}`);
      container.replaceChildren(renderDetail(event, host));
    } catch (err) {
      container.replaceChildren(
        err.status === 404
          ? message('error', text('notFound'))
          : message('error', text('loadError'),
              h('button', { class: 'ev-button', type: 'button', onclick: () => loadDetail(container, slug, host) }, text('retry')),
            ),
      );
    }
  }

  // Dialog ------------------------------------------------------------------------------------

  let dialog;

  function openDialog(slug, host) {
    if (!dialog) {
      const content = h('div', { class: 'ev-dialog__content' });
      dialog = h('dialog', { class: 'ev-dialog', 'aria-labelledby': 'ev-detail-title' },
        h('button', { class: 'ev-dialog__close', type: 'button', 'aria-label': text('close'), onclick: () => dialog.close() }, '×'),
        content,
      );
      dialog.content = content;
      // A click on the backdrop lands on the dialog element itself.
      dialog.addEventListener('click', (click) => click.target === dialog && dialog.close());
      dialog.addEventListener('close', () => {
        document.documentElement.classList.remove('ev-dialog-open');
        if (location.hash.startsWith(HASH_PREFIX)) {
          history.pushState(null, '', location.pathname + location.search);
        }
      });
      document.body.append(dialog);
    }
    // Websites that swap their content on navigation may have removed the dialog.
    if (!dialog.isConnected) document.body.append(dialog);
    if (dialog.currentSlug !== slug || !dialog.open) {
      dialog.currentSlug = slug;
      dialog.scrollTop = 0;
      loadDetail(dialog.content, slug, host);
    }
    if (!dialog.open) {
      dialog.showModal();
      document.documentElement.classList.add('ev-dialog-open');
    }
  }

  function followHash() {
    const host = document.querySelector('event-list');
    if (!host) return;
    if (location.hash.startsWith(HASH_PREFIX)) {
      openDialog(decodeURIComponent(location.hash.slice(HASH_PREFIX.length)), host);
    } else if (dialog?.open) {
      dialog.close();
    }
  }

  // Elements ----------------------------------------------------------------------------------

  class EventList extends HTMLElement {
    static observedAttributes = ['when', 'limit', 'format'];

    connectedCallback() {
      this.load();
      if (!EventList.listening) {
        EventList.listening = true;
        addEventListener('hashchange', followHash);
        // Buyers who pressed "back" on the payment page get buttons that work again.
        addEventListener('pageshow', (show) => show.persisted && followHash());
      }
      followHash();
    }

    attributeChangedCallback(_name, before, after) {
      if (this.isConnected && before !== after) this.load();
    }

    async load() {
      const current = (this.request = Symbol());
      if (!this.firstElementChild) this.replaceChildren(message('info', text('loading')));
      this.setAttribute('aria-busy', 'true');
      try {
        const when = this.getAttribute('when') ?? 'upcoming';
        let { events } = await api(`/v1/events?when=${encodeURIComponent(when)}`);
        if (current !== this.request) return;

        const format = this.getAttribute('format');
        if (format) events = events.filter((event) => event.format === format || event.format === 'hybrid');
        const limit = Number(this.getAttribute('limit'));
        if (limit > 0) events = events.slice(0, limit);

        this.replaceChildren(
          events.length > 0
            ? h('ul', { class: 'ev-list' }, events.map((event) => renderCard(event, this)))
            : message('info', this.getAttribute('empty-text') ?? text('empty')),
        );
        this.dispatchEvent(new CustomEvent('event-list-loaded', { bubbles: true, detail: { events } }));
      } catch {
        if (current !== this.request) return;
        this.replaceChildren(
          message('error', text('loadError'),
            h('button', { class: 'ev-button', type: 'button', onclick: () => this.load() }, text('retry')),
          ),
        );
      } finally {
        if (current === this.request) this.removeAttribute('aria-busy');
      }
    }
  }

  class EventDetail extends HTMLElement {
    static observedAttributes = ['slug'];

    connectedCallback() {
      this.load();
    }

    attributeChangedCallback(_name, before, after) {
      if (this.isConnected && before !== after) this.load();
    }

    load() {
      const slug = this.getAttribute('slug') ?? new URLSearchParams(location.search).get('event');
      if (slug) loadDetail(this, slug, this);
      else this.replaceChildren(message('error', text('notFound')));
    }
  }

  class EventOrderStatus extends HTMLElement {
    connectedCallback() {
      this.attempts = 0;
      this.check();
    }

    disconnectedCallback() {
      clearTimeout(this.timer);
    }

    show(kind, title, ...lines) {
      this.dataset.status = kind;
      this.replaceChildren(
        h('div', { class: `ev-status ev-status--${kind}`, role: 'status' },
          h(headingTag(this, -1), { class: 'ev-status__title' }, title),
          lines.filter(Boolean).map((line) => h('p', {}, line)),
        ),
      );
    }

    async check() {
      const sessionId = this.getAttribute('session-id') ?? new URLSearchParams(location.search).get('session_id');
      if (!sessionId) return this.show('unknown', text('statusUnknownTitle'), text('statusUnknown'));
      if (this.attempts === 0) this.show('checking', text('statusChecking'));

      let order;
      try {
        order = await api(`/v1/orders/status?session_id=${encodeURIComponent(sessionId)}`);
      } catch (err) {
        if (err.status === 404) return this.show('unknown', text('statusUnknownTitle'), text('statusUnknown'));
        order = { status: 'pending' };
      }

      if (order.status === 'paid') {
        this.show('paid', text('statusPaidTitle'),
          text('statusPaid', { event: order.event.title, tickets: `${order.quantity} × ${order.ticket_name}` }),
          order.customer_email ? text('statusMail', { email: order.customer_email }) : text('statusMailGeneric'),
        );
        this.dispatchEvent(new CustomEvent('event-order-paid', { bubbles: true, detail: { order } }));
      } else if (order.status === 'refunded') {
        this.show('refunded', text('statusRefundedTitle'));
      } else if (order.status === 'expired' || order.status === 'cancelled') {
        this.show('failed', text('statusFailedTitle'), text('statusFailed'));
      } else if (++this.attempts < (Number(this.getAttribute('max-attempts')) || 15)) {
        // The confirmation from the payment provider usually arrives within seconds.
        this.timer = setTimeout(() => this.check(), Number(this.getAttribute('interval')) || 2000);
      } else {
        this.show('slow', text('statusSlowTitle'), text('statusSlow'));
      }
    }
  }

  // Styles ------------------------------------------------------------------------------------

  const STYLES = `
:where(event-list, event-detail, event-order-status) { display: block; }
:where(event-list, event-detail, event-order-status, .ev-dialog) {
  --ev-accent: #1f4fd8;
  --ev-accent-text: #fff;
  --ev-muted: color-mix(in srgb, currentColor 65%, transparent);
  --ev-border: color-mix(in srgb, currentColor 18%, transparent);
  --ev-radius: 12px;
  --ev-gap: 1.5rem;
}
:where(.ev-list) { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr)); gap: var(--ev-gap); list-style: none; margin: 0; padding: 0; }
:where(.ev-card) { border: 1px solid var(--ev-border); border-radius: var(--ev-radius); overflow: hidden; transition: box-shadow .15s, transform .15s; }
:where(.ev-card:hover, .ev-card:focus-within) { box-shadow: 0 6px 24px rgb(0 0 0 / .12); transform: translateY(-2px); }
:where(.ev-card__link) { display: flex; flex-direction: column; height: 100%; color: inherit; text-decoration: none; }
:where(.ev-card__image) { display: block; width: 100%; height: auto; aspect-ratio: 16 / 9; object-fit: cover; }
:where(.ev-card__body) { display: flex; flex-direction: column; gap: .5rem; flex: 1; padding: 1.25rem; }
:where(.ev-card__body, .ev-detail__header, .ev-ticket__info) > :where(*) { margin: 0; }
:where(.ev-card__date, .ev-detail__date) { font-size: .875em; font-weight: 600; color: var(--ev-accent); }
:where(.ev-card__title) { font-size: 1.2em; line-height: 1.3; }
:where(.ev-card__summary) { color: var(--ev-muted); }
:where(.ev-card__price, .ev-card__note) { margin-top: auto; padding-top: .5rem; font-weight: 600; }
:where(.ev-card__note, .ev-detail__note) { color: var(--ev-muted); }
:where(.ev-meta) { display: flex; flex-wrap: wrap; align-items: center; gap: .5rem; font-size: .875em; color: var(--ev-muted); }
:where(.ev-badge) { padding: .15em .65em; border: 1px solid var(--ev-border); border-radius: 99px; white-space: nowrap; }
:where(.ev-button) { padding: .7em 1.4em; border: 0; border-radius: calc(var(--ev-radius) / 1.5); background: var(--ev-accent); color: var(--ev-accent-text); font: inherit; font-weight: 600; cursor: pointer; }
:where(.ev-button:hover) { filter: brightness(1.1); }
:where(.ev-button:disabled) { opacity: .6; cursor: progress; }
:where(.ev-button, .ev-dialog__close, .ev-card__link, .ev-ticket__quantity):focus-visible { outline: 3px solid color-mix(in srgb, var(--ev-accent) 55%, transparent); outline-offset: 2px; }
:where(.ev-message) { padding: 1.5rem; border: 1px dashed var(--ev-border); border-radius: var(--ev-radius); text-align: center; color: var(--ev-muted); }
:where(.ev-message) > :where(p) { margin: 0 0 .75rem; }
:where(.ev-message) > :where(:last-child) { margin-bottom: 0; }
:where(.ev-dialog) { width: min(46rem, calc(100vw - 2rem)); max-height: calc(100dvh - 2rem); padding: 0; border: 0; border-radius: var(--ev-radius); background: Canvas; color: CanvasText; box-shadow: 0 24px 80px rgb(0 0 0 / .35); overflow: auto; overscroll-behavior: contain; }
:where(.ev-dialog)::backdrop { background: rgb(0 0 0 / .55); }
:where(.ev-dialog__close) { position: sticky; top: .75rem; float: right; margin: .75rem .75rem -3.25rem 0; width: 2.5rem; height: 2.5rem; border: 0; border-radius: 50%; background: rgb(0 0 0 / .55); color: #fff; font: inherit; font-size: 1.5rem; line-height: 1; cursor: pointer; z-index: 1; }
:where(.ev-dialog__content) > :where(.ev-message) { margin: 3.5rem 1.5rem 1.5rem; }
:where(html.ev-dialog-open) { overflow: hidden; }
:where(.ev-detail__image) { display: block; width: 100%; height: auto; max-height: 22rem; object-fit: cover; }
:where(.ev-detail__header, .ev-detail__description, .ev-tickets) { padding: 0 1.5rem; }
:where(event-detail) :where(.ev-detail__header, .ev-detail__description, .ev-tickets) { padding: 0; }
:where(.ev-detail__header) { display: flex; flex-direction: column; gap: .5rem; margin: 1.5rem 0 1rem; }
:where(.ev-detail__title) { font-size: 1.6em; line-height: 1.25; }
:where(.ev-detail__description) { line-height: 1.6; overflow-wrap: anywhere; }
:where(.ev-detail__description) :where(a) { color: var(--ev-accent); }
:where(.ev-tickets) { margin: 1.5rem 0; }
:where(.ev-tickets__title) { margin: 0 0 .75rem; font-size: 1.15em; }
:where(.ev-tickets__note) { margin: .75rem 0 0; font-size: .85em; color: var(--ev-muted); }
:where(.ev-ticket) { display: grid; grid-template-columns: 1fr auto; align-items: center; gap: .75rem 1.5rem; padding: 1rem 1.25rem; margin: 0 0 .75rem; border: 1px solid var(--ev-border); border-radius: var(--ev-radius); }
:where(.ev-ticket[data-on-sale="false"]) { opacity: .7; }
:where(.ev-ticket__info) { display: flex; flex-direction: column; gap: .25rem; }
:where(.ev-ticket__name) { font-weight: 600; }
:where(.ev-ticket__description, .ev-ticket__tax) { color: var(--ev-muted); font-size: .9em; font-weight: 400; }
:where(.ev-ticket__hint) { font-size: .875em; font-weight: 600; color: #b45309; }
:where(.ev-ticket__price) { margin: 0; font-weight: 700; font-size: 1.1em; text-align: right; white-space: nowrap; }
:where(.ev-ticket__action) { grid-column: 1 / -1; display: flex; align-items: center; justify-content: flex-end; gap: .75rem; }
:where(.ev-ticket__label) { font-size: .9em; color: var(--ev-muted); }
:where(.ev-ticket__quantity) { padding: .6em .5em; border: 1px solid var(--ev-border); border-radius: calc(var(--ev-radius) / 1.5); background: transparent; color: inherit; font: inherit; }
:where(.ev-ticket__error) { grid-column: 1 / -1; margin: 0; padding: .75rem 1rem; border-radius: calc(var(--ev-radius) / 1.5); background: color-mix(in srgb, #dc2626 12%, transparent); color: #b91c1c; }
:where(.ev-ticket__error[hidden]) { display: none; }
:where(.ev-status) { padding: 2rem; border: 1px solid var(--ev-border); border-radius: var(--ev-radius); text-align: center; }
:where(.ev-status__title) { margin: 0 0 .75rem; font-size: 1.5em; }
:where(.ev-status) > :where(p) { margin: .5rem 0 0; color: var(--ev-muted); }
:where(.ev-status--paid) { border-color: color-mix(in srgb, #16a34a 50%, transparent); }
@media (max-width: 30rem) {
  :where(.ev-ticket) { grid-template-columns: 1fr; }
  :where(.ev-ticket__price) { text-align: left; }
  :where(.ev-ticket__action) { justify-content: stretch; }
  :where(.ev-ticket__action) > :where(.ev-button) { flex: 1; }
}
@media (prefers-reduced-motion: reduce) { :where(.ev-card) { transition: none; } }
`;

  if (config.styles !== false && script?.dataset.styles !== 'off') {
    // Placed first in the head, so rules of the website come later and win.
    document.head.prepend(h('style', { 'data-event-widgets': true }, STYLES));
  }

  customElements.define('event-list', EventList);
  customElements.define('event-detail', EventDetail);
  customElements.define('event-order-status', EventOrderStatus);
})();
