import { z } from 'zod';

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  ADMIN_TOKEN: z.string().min(32, 'must be at least 32 characters'),
  APP_SECRET: z.string().min(32, 'must be at least 32 characters'),
  PUBLIC_BASE_URL: z.url().default('http://localhost:3000'),
  SMTP_PASSWORD: z.string().min(1).optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  adminToken: string;
  appSecret: string;
  publicBaseUrl: string;
  smtpPasswordOverride: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  const value = parsed.data;
  if (value.NODE_ENV === 'production' && !value.DATABASE_URL?.startsWith('postgres')) {
    throw new Error('Invalid configuration:\n  DATABASE_URL: a postgres:// URL is required in production');
  }
  return {
    env: value.NODE_ENV,
    port: value.PORT,
    databaseUrl: value.DATABASE_URL ?? 'pglite://.data/pglite',
    adminToken: value.ADMIN_TOKEN,
    appSecret: value.APP_SECRET,
    publicBaseUrl: value.PUBLIC_BASE_URL.replace(/\/+$/, ''),
    smtpPasswordOverride: value.SMTP_PASSWORD,
  };
}
