import Stripe from 'stripe';
import type { AppContext } from '../context.ts';
import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { DomainError } from '../lib/errors.ts';
import { getStripeSettings, saveStripeSettings } from './settings.ts';

export const WEBHOOK_PATH = '/webhooks/stripe';

export const WEBHOOK_EVENTS = [
  'checkout.session.completed',
  'checkout.session.expired',
  'checkout.session.async_payment_succeeded',
  'checkout.session.async_payment_failed',
  'charge.refunded',
] as const;

const KEY_PATTERN = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/;

export type StripeMode = 'test' | 'live';
type Source = 'environment' | 'database' | null;

export interface StripeCredentials {
  secretKey: string | null;
  secretKeySource: Source;
  webhookSecret: string | null;
  webhookSecretSource: Source;
  /** null while there is no key or the key is malformed. */
  mode: StripeMode | null;
  /** What is wrong with the form of the secret key, if anything. */
  secretKeyProblem: string | null;
}

function modeOf(secretKey: string): StripeMode | null {
  const match = /^(?:sk|rk)_(test|live)_/.exec(secretKey);
  return match ? (match[1] as StripeMode) : null;
}

/**
 * Explains what is wrong with the form of a secret key. The answer never contains
 * the key itself, only its kind and length.
 */
export function diagnoseSecretKey(key: string): string | null {
  if (KEY_PATTERN.test(key)) return null;
  const expected = 'A secret key starts with sk_test_, sk_live_, rk_test_ or rk_live_.';

  if (key !== key.trim()) return 'The secret key has spaces or line breaks at its start or end.';
  if (/^["'`].*["'`]$/.test(key)) {
    return 'The secret key is wrapped in quotation marks. Enter the key without them.';
  }
  if (key.startsWith('pk_')) {
    return `This is the publishable key (pk_…), not the secret key. ${expected}`;
  }
  if (key.startsWith('whsec_')) {
    return `This is a webhook secret (whsec_…), not the secret key. ${expected}`;
  }
  if (/^(sk|rk)_(test|live)_/.test(key)) {
    return /^[A-Za-z0-9_]+$/.test(key)
      ? `The secret key is too short (${key.length} characters). It was probably copied incompletely.`
      : 'The secret key contains characters that do not belong in a key, such as spaces, line breaks or dots. It was probably copied incompletely or together with other text.';
  }
  if (/^(sk|rk)_/.test(key)) {
    return `The secret key lacks the part that says test or live. ${expected}`;
  }
  return `The value does not look like a Stripe key. ${expected}`;
}

/** Keys from the environment win over the ones stored through MCP. */
export async function getStripeCredentials(ctx: AppContext): Promise<StripeCredentials> {
  const { config } = ctx;
  const stored = await getStripeSettings(ctx.db);
  const decrypt = (value: string | null) => (value ? decryptSecret(value, config.appSecret) : null);

  const secretKey = config.stripeSecretKeyOverride ?? decrypt(stored.secret_key_encrypted);
  const webhookSecret =
    config.stripeWebhookSecretOverride ?? decrypt(stored.webhook_secret_encrypted);
  const secretKeyProblem = secretKey ? diagnoseSecretKey(secretKey) : null;
  return {
    secretKey,
    secretKeySource: config.stripeSecretKeyOverride
      ? 'environment'
      : stored.secret_key_encrypted
        ? 'database'
        : null,
    webhookSecret,
    webhookSecretSource: config.stripeWebhookSecretOverride
      ? 'environment'
      : stored.webhook_secret_encrypted
        ? 'database'
        : null,
    mode: secretKey && !secretKeyProblem ? modeOf(secretKey) : null,
    secretKeyProblem,
  };
}

export function createStripe(ctx: AppContext, secretKey: string): Stripe {
  const connection = ctx.stripe ?? {};
  return new Stripe(secretKey, {
    maxNetworkRetries: 2,
    timeout: 20_000,
    appInfo: { name: 'event-backend', version: '0.2.0' },
    ...(connection.fetch ? { httpClient: Stripe.createFetchHttpClient(connection.fetch) } : {}),
    ...(connection.host ? { host: connection.host } : {}),
    ...(connection.port ? { port: connection.port } : {}),
    ...(connection.protocol ? { protocol: connection.protocol } : {}),
  });
}

export async function requireStripe(
  ctx: AppContext,
): Promise<{ stripe: Stripe; mode: StripeMode; credentials: StripeCredentials }> {
  const credentials = await getStripeCredentials(ctx);
  if (!credentials.secretKey || !credentials.mode || credentials.secretKeyProblem) {
    throw new DomainError(
      'unavailable',
      credentials.secretKeyProblem ?? 'Stripe is not connected yet.',
      'not_configured',
    );
  }
  return { stripe: createStripe(ctx, credentials.secretKey), mode: credentials.mode, credentials };
}

/** Turns failures of the Stripe API into messages an administrator can act on. */
export function explainStripeError(err: unknown): DomainError {
  if (err instanceof DomainError) return err;
  if (err instanceof Stripe.errors.StripeAuthenticationError) {
    return new DomainError('invalid', 'Stripe rejected the secret key. It is wrong or was revoked.');
  }
  if (err instanceof Stripe.errors.StripePermissionError) {
    return new DomainError(
      'invalid',
      `The Stripe key lacks a permission: ${err.message}`,
    );
  }
  if (err instanceof Stripe.errors.StripeConnectionError) {
    return new DomainError('unavailable', 'Stripe could not be reached. Try again in a moment.');
  }
  if (err instanceof Stripe.errors.StripeError) {
    return new DomainError('invalid', `Stripe answered: ${err.message}`);
  }
  throw err;
}

/** What keeps tickets from being sold, as far as it can be told without asking Stripe. */
export async function listSetupProblems(ctx: AppContext): Promise<string[]> {
  const [credentials, general] = await Promise.all([getStripeCredentials(ctx), ctx.generalSettings()]);
  const problems: string[] = [];
  if (!credentials.secretKey) problems.push('No Stripe secret key is set.');
  else if (credentials.secretKeyProblem) {
    const where =
      credentials.secretKeySource === 'environment' ? 'STRIPE_SECRET_KEY in the environment' : 'The stored key';
    problems.push(`${where} is not usable. ${credentials.secretKeyProblem}`);
  }
  if (!credentials.webhookSecret) {
    problems.push(
      'No webhook secret is set. Payments cannot be confirmed without it. Use create_stripe_webhook.',
    );
  }
  if (!general.checkout_success_url || !general.checkout_cancel_url) {
    problems.push('checkout_success_url and checkout_cancel_url are not set in the settings.');
  }
  if (general.default_tax_percent === null) {
    problems.push('default_tax_percent is not set in the settings. Use 0 if no tax is to be shown.');
  }
  return problems;
}

export async function getStripeStatus(ctx: AppContext) {
  const credentials = await getStripeCredentials(ctx);
  const stored = await getStripeSettings(ctx.db);
  const webhookUrl = `${ctx.config.publicBaseUrl}${WEBHOOK_PATH}`;

  const status = {
    connected: false,
    mode: credentials.mode,
    secret_key_source: credentials.secretKeySource,
    account: null as null | {
      id: string;
      name: string | null;
      country: string | null;
      charges_enabled: boolean | null;
    },
    webhook: {
      url: webhookUrl,
      secret_set: credentials.webhookSecret !== null,
      secret_source: credentials.webhookSecretSource,
      endpoint_id: stored.webhook_endpoint_id,
    },
    problems: await listSetupProblems(ctx),
  };

  if (credentials.secretKey && !credentials.secretKeyProblem) {
    try {
      const account = await createStripe(ctx, credentials.secretKey).accounts.retrieveCurrent();
      status.connected = true;
      status.account = {
        id: account.id,
        name:
          account.settings?.dashboard?.display_name ?? account.business_profile?.name ?? null,
        country: account.country ?? null,
        charges_enabled: account.charges_enabled ?? null,
      };
      if (account.charges_enabled === false) {
        status.problems.push('The Stripe account cannot accept payments yet. Finish the setup at Stripe.');
      }
    } catch (err) {
      if (err instanceof Stripe.errors.StripePermissionError) {
        // Restricted keys may not read the account. The key itself is fine.
        status.connected = true;
      } else if (err instanceof Stripe.errors.StripeAuthenticationError) {
        status.problems.push(
          `Stripe rejected the secret key. Its form is right (${credentials.mode} mode, ` +
            `${credentials.secretKey.length} characters), so it was probably deleted or replaced ` +
            'at Stripe, or characters in the middle are missing. Create a new key at Stripe.',
        );
      } else {
        status.problems.push(explainStripeError(err).message);
      }
    }
  }
  return { ...status, ready_for_sales: status.connected && status.problems.length === 0 };
}

export async function updateStripeKeys(
  ctx: AppContext,
  patch: { secret_key?: string | null; webhook_secret?: string | null },
): Promise<{ notes: string[] }> {
  const { config, db } = ctx;
  const notes: string[] = [];
  const stored = await getStripeSettings(db);
  const next = { ...stored };

  if (patch.secret_key !== undefined) {
    if (config.stripeSecretKeyOverride) {
      throw new DomainError('conflict', 'The secret key is set through STRIPE_SECRET_KEY in the environment.');
    }
    if (patch.secret_key === null) {
      next.secret_key_encrypted = null;
    } else {
      const key = patch.secret_key.trim();
      const problem = diagnoseSecretKey(key);
      if (problem) throw new DomainError('invalid', problem);
      try {
        await createStripe(ctx, key).accounts.retrieveCurrent();
      } catch (err) {
        if (!(err instanceof Stripe.errors.StripePermissionError)) throw explainStripeError(err);
      }
      const previous = stored.secret_key_encrypted
        ? modeOf(decryptSecret(stored.secret_key_encrypted, config.appSecret))
        : null;
      if (previous && previous !== modeOf(key) && stored.webhook_secret_encrypted) {
        // Webhooks exist per mode, so the old secret cannot verify events of the new mode.
        next.webhook_secret_encrypted = null;
        next.webhook_endpoint_id = null;
        notes.push(
          `Switched from ${previous} to ${modeOf(key)} mode. The webhook was reset, run create_stripe_webhook again.`,
        );
      }
      next.secret_key_encrypted = encryptSecret(key, config.appSecret);
    }
  }

  if (patch.webhook_secret !== undefined) {
    if (config.stripeWebhookSecretOverride) {
      throw new DomainError(
        'conflict',
        'The webhook secret is set through STRIPE_WEBHOOK_SECRET in the environment.',
      );
    }
    if (patch.webhook_secret === null) {
      next.webhook_secret_encrypted = null;
      next.webhook_endpoint_id = null;
    } else {
      const secret = patch.webhook_secret.trim();
      if (!secret.startsWith('whsec_')) {
        throw new DomainError('invalid', 'A Stripe webhook secret starts with whsec_.');
      }
      next.webhook_secret_encrypted = encryptSecret(secret, config.appSecret);
      next.webhook_endpoint_id = null;
    }
  }

  await saveStripeSettings(db, next);
  return { notes };
}

/** Registers this service as webhook endpoint at Stripe and stores the signing secret. */
export async function createStripeWebhook(ctx: AppContext) {
  const { config, db } = ctx;
  if (config.stripeWebhookSecretOverride) {
    throw new DomainError(
      'conflict',
      'The webhook secret is set through STRIPE_WEBHOOK_SECRET in the environment.',
    );
  }
  const url = `${config.publicBaseUrl}${WEBHOOK_PATH}`;
  if (!url.startsWith('https://')) {
    throw new DomainError(
      'invalid',
      `Stripe only delivers webhooks to public https addresses, but PUBLIC_BASE_URL is ${config.publicBaseUrl}.`,
    );
  }

  const { stripe } = await requireStripe(ctx);
  try {
    const stored = await getStripeSettings(db);
    if (stored.webhook_endpoint_id) {
      await stripe.webhookEndpoints.del(stored.webhook_endpoint_id).catch(() => {});
    }
    const endpoint = await stripe.webhookEndpoints.create({
      url,
      enabled_events: [...WEBHOOK_EVENTS],
      description: 'event-backend',
    });
    if (!endpoint.secret) throw new DomainError('invalid', 'Stripe did not return a signing secret.');

    await saveStripeSettings(db, {
      ...(await getStripeSettings(db)),
      webhook_secret_encrypted: encryptSecret(endpoint.secret, config.appSecret),
      webhook_endpoint_id: endpoint.id,
    });
    return { endpoint_id: endpoint.id, url, events: [...WEBHOOK_EVENTS] };
  } catch (err) {
    throw explainStripeError(err);
  }
}

/** Returns the Stripe tax rate for a percentage and creates it on first use. */
export async function ensureTaxRate(
  ctx: AppContext,
  stripe: Stripe,
  mode: StripeMode,
  percent: number,
): Promise<string | null> {
  if (percent === 0) return null;
  const cacheKey = `${mode}:${percent}`;
  const stored = await getStripeSettings(ctx.db);
  const known = stored.tax_rate_ids[cacheKey];
  if (known) return known;

  const rate = await stripe.taxRates.create({
    display_name: 'USt.',
    percentage: percent,
    inclusive: true,
    metadata: { created_by: 'event-backend' },
  });
  const latest = await getStripeSettings(ctx.db);
  await saveStripeSettings(ctx.db, {
    ...latest,
    tax_rate_ids: { ...latest.tax_rate_ids, [cacheKey]: rate.id },
  });
  return rate.id;
}
