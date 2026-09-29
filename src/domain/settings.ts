import { z } from 'zod';
import type { Queryable } from '../db/index.ts';
import { decryptSecret, encryptSecret } from '../lib/crypto.ts';
import { DomainError } from '../lib/errors.ts';

const httpUrl = z.url({ protocol: /^https?$/ });

/** An origin as browsers send it: scheme and host, without a path. */
const origin = z
  .string()
  .refine((value) => URL.canParse(value) && new URL(value).origin === value, {
    message: 'must be an origin such as https://www.example.com (no path, no trailing slash)',
  });

export const generalSettingsSchema = z.object({
  organizer_name: z.string().max(200).default(''),
  website_url: httpUrl.nullable().default(null),
  /** Websites that may call the public API from a browser. Empty means any website. */
  allowed_origins: z.array(origin).max(20).default([]),
  checkout_success_url: httpUrl.nullable().default(null),
  checkout_cancel_url: httpUrl.nullable().default(null),
  terms_url: httpUrl.nullable().default(null),
  privacy_url: httpUrl.nullable().default(null),
  /** The public API shows the number of free seats only at or below this value. */
  low_stock_threshold: z.number().int().min(0).max(1000).default(10),
  /**
   * Tax rate included in ticket prices. null means undecided and blocks ticket sales,
   * 0 means that no tax is shown.
   */
  default_tax_percent: z.number().min(0).max(100).nullable().default(null),
  /** Let Stripe create and send an invoice for every purchase. */
  stripe_invoices: z.boolean().default(true),
  /** Printed at the bottom of invoices, e.g. a note on tax exemption. */
  invoice_footer: z.string().max(1000).default(''),
  /** Optional paragraphs for the confirmation mail. */
  confirmation_intro: z.string().max(2000).default(''),
  confirmation_footer: z.string().max(2000).default(''),
});

export const stripeSettingsSchema = z.object({
  secret_key_encrypted: z.string().nullable().default(null),
  webhook_secret_encrypted: z.string().nullable().default(null),
  webhook_endpoint_id: z.string().nullable().default(null),
  /** Tax rate objects at Stripe, by mode and percentage, e.g. "test:19". */
  tax_rate_ids: z.record(z.string(), z.string()).default({}),
});

export const mailSettingsSchema = z.object({
  host: z.string().max(255).nullable().default(null),
  port: z.number().int().min(1).max(65535).default(587),
  /** starttls: upgrade on port 587. tls: encrypted from the start, usually port 465. */
  security: z.enum(['starttls', 'tls', 'none']).default('starttls'),
  username: z.string().max(255).nullable().default(null),
  password_encrypted: z.string().nullable().default(null),
  from_name: z.string().max(200).default(''),
  from_email: z.email().nullable().default(null),
  reply_to: z.email().nullable().default(null),
});

export type GeneralSettings = z.infer<typeof generalSettingsSchema>;
export type MailSettings = z.infer<typeof mailSettingsSchema>;
export type StripeSettings = z.infer<typeof stripeSettingsSchema>;
export type GeneralSettingsPatch = Partial<GeneralSettings>;
export type MailSettingsPatch = Partial<Omit<MailSettings, 'password_encrypted'>> & {
  /** Plain password. null removes the stored one. */
  password?: string | null;
};

export type PublicMailSettings = Omit<MailSettings, 'password_encrypted'> & {
  password_set: boolean;
  password_source: 'environment' | 'database' | null;
  ready: boolean;
};

async function read<S extends z.ZodType>(db: Queryable, key: string, schema: S): Promise<z.infer<S>> {
  const [row] = await db.query<{ value: unknown }>('select value from settings where key = $1', [key]);
  return schema.parse(row?.value ?? {});
}

async function write(db: Queryable, key: string, value: unknown): Promise<void> {
  await db.query(
    `insert into settings (key, value) values ($1, $2::text::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

function parseOrThrow<S extends z.ZodType>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
  throw new DomainError('invalid', problems.join('; '));
}

export function getGeneralSettings(db: Queryable): Promise<GeneralSettings> {
  return read(db, 'general', generalSettingsSchema);
}

export async function updateGeneralSettings(
  db: Queryable,
  patch: GeneralSettingsPatch,
): Promise<GeneralSettings> {
  const next = parseOrThrow(generalSettingsSchema, { ...(await getGeneralSettings(db)), ...defined(patch) });
  await write(db, 'general', next);
  return next;
}

export function getMailSettings(db: Queryable): Promise<MailSettings> {
  return read(db, 'mail', mailSettingsSchema);
}

export async function updateMailSettings(
  db: Queryable,
  patch: MailSettingsPatch,
  appSecret: string,
): Promise<MailSettings> {
  const { password, ...rest } = patch;
  const current = await getMailSettings(db);
  const next = parseOrThrow(mailSettingsSchema, {
    ...current,
    ...defined(rest),
    password_encrypted:
      password === undefined
        ? current.password_encrypted
        : password === null
          ? null
          : encryptSecret(password, appSecret),
  });
  await write(db, 'mail', next);
  return next;
}

export interface CheckoutFailure {
  at: string;
  message: string;
}

/** The reason why the last checkout could not be opened, for the administrator. */
export async function getLastCheckoutFailure(db: Queryable): Promise<CheckoutFailure | null> {
  const [row] = await db.query<{ value: CheckoutFailure }>(
    "select value from settings where key = 'checkout_failure'",
  );
  return row?.value ?? null;
}

export async function recordCheckoutFailure(db: Queryable, message: string): Promise<void> {
  await write(db, 'checkout_failure', { at: new Date().toISOString(), message: message.slice(0, 1000) });
}

export async function clearCheckoutFailure(db: Queryable): Promise<void> {
  await db.query("delete from settings where key = 'checkout_failure'");
}

export function getStripeSettings(db: Queryable): Promise<StripeSettings> {
  return read(db, 'stripe', stripeSettingsSchema);
}

export async function saveStripeSettings(db: Queryable, settings: StripeSettings): Promise<void> {
  await write(db, 'stripe', parseOrThrow(stripeSettingsSchema, settings));
}

/** The SMTP password. A value from the environment wins over the stored one. */
export function resolveMailPassword(
  settings: MailSettings,
  secrets: { appSecret: string; smtpPasswordOverride?: string | undefined },
): string | null {
  if (secrets.smtpPasswordOverride) return secrets.smtpPasswordOverride;
  if (!settings.password_encrypted) return null;
  return decryptSecret(settings.password_encrypted, secrets.appSecret);
}

export function describeMailSettings(
  settings: MailSettings,
  secrets: { smtpPasswordOverride?: string | undefined },
): PublicMailSettings {
  const { password_encrypted, ...visible } = settings;
  const source = secrets.smtpPasswordOverride
    ? 'environment'
    : password_encrypted
      ? 'database'
      : null;
  return {
    ...visible,
    password_set: source !== null,
    password_source: source,
    ready: Boolean(settings.host && settings.from_email),
  };
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
