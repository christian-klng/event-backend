import Stripe from 'stripe';

export interface StripeRequest {
  method: string;
  path: string;
  /** Form fields as Stripe receives them, e.g. "line_items[0][quantity]". */
  params: Record<string, string>;
  idempotencyKey: string | null;
}

export const WEBHOOK_SECRET = 'whsec_test_secret_for_signing';

/** Stands in for the Stripe API. The real SDK talks to it, so request formats are the real ones. */
export function createFakeStripe() {
  const requests: StripeRequest[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  let counter = 0;
  let failure: { status: number; body: unknown } | null = null;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', 'request-id': `req_${++counter}` },
    });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(init?.headers);
    const params = Object.fromEntries(new URLSearchParams(init?.body ? String(init.body) : ''));
    requests.push({
      method,
      path: url.pathname,
      params,
      idempotencyKey: headers.get('idempotency-key'),
    });

    if (failure) {
      const { status, body } = failure;
      failure = null;
      return json(body, status);
    }
    if (headers.get('authorization') === 'Bearer sk_test_revoked00000000000') {
      return json({ error: { type: 'invalid_request_error', message: 'Invalid API Key provided' } }, 401);
    }

    const route = `${method} ${url.pathname}`;
    if (route === 'GET /v1/account') {
      return json({
        id: 'acct_test',
        object: 'account',
        country: 'DE',
        charges_enabled: true,
        settings: { dashboard: { display_name: 'Beispiel Akademie' } },
      });
    }
    if (route === 'POST /v1/tax_rates') {
      return json({ id: `txr_${++counter}`, object: 'tax_rate', percentage: Number(params.percentage) });
    }
    if (route === 'POST /v1/checkout/sessions') {
      const id = `cs_test_${++counter}`;
      const session = {
        id,
        object: 'checkout.session',
        livemode: false,
        url: `https://checkout.stripe.com/c/pay/${id}`,
        client_reference_id: params.client_reference_id,
        payment_intent: null,
        invoice: null,
      };
      sessions.set(id, session);
      return json(session);
    }
    if (method === 'GET' && url.pathname.startsWith('/v1/checkout/sessions/')) {
      const session = sessions.get(url.pathname.split('/').at(-1) ?? '');
      return session
        ? json(session)
        : json({ error: { type: 'invalid_request_error', message: 'No such session' } }, 404);
    }
    if (route === 'POST /v1/credit_notes') return json({ id: `cn_${++counter}`, object: 'credit_note' });
    if (route === 'POST /v1/refunds') return json({ id: `re_${++counter}`, object: 'refund' });
    if (route === 'POST /v1/webhook_endpoints') {
      return json({
        id: `we_${++counter}`,
        object: 'webhook_endpoint',
        url: params.url,
        secret: WEBHOOK_SECRET,
      });
    }
    if (method === 'DELETE' && url.pathname.startsWith('/v1/webhook_endpoints/')) {
      return json({ id: url.pathname.split('/').at(-1), object: 'webhook_endpoint', deleted: true });
    }
    return json({ error: { type: 'invalid_request_error', message: `Unexpected ${route}` } }, 404);
  }) as typeof fetch;

  return {
    fetch: fetchImpl,
    requests,
    sessions,

    requestsTo(route: string): StripeRequest[] {
      return requests.filter((request) => `${request.method} ${request.path}` === route);
    },

    /** The next request fails with this answer. */
    failNext(status: number, message: string, type = 'api_error') {
      failure = { status, body: { error: { type, message } } };
    },

    /** Simulates what Stripe knows after the buyer paid. */
    completeSession(id: string, fields: Record<string, unknown>) {
      sessions.set(id, { ...sessions.get(id), ...fields });
    },

    reset() {
      requests.length = 0;
      sessions.clear();
      failure = null;
    },

    /** A webhook request as Stripe sends it, with a valid signature. */
    async signedEvent(type: string, object: Record<string, unknown>, id = `evt_${++counter}`) {
      const payload = JSON.stringify({
        id,
        object: 'event',
        type,
        livemode: false,
        created: Math.floor(Date.now() / 1000),
        data: { object },
      });
      const signature = await Stripe.webhooks.generateTestHeaderStringAsync({
        payload,
        secret: WEBHOOK_SECRET,
      });
      return { payload, signature, id };
    },
  };
}

export type FakeStripe = ReturnType<typeof createFakeStripe>;
