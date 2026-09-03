import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';

export const config = {
  isTest,
  port: Number(process.env.PORT ?? 3000),
  /** Tests get their own database so a run never clobbers dev data. */
  databaseUrl: isTest
    ? (process.env.TEST_DATABASE_URL ?? required('DATABASE_URL'))
    : required('DATABASE_URL'),
  redisUrl: required('REDIS_URL'),
  /** Tests namespace their Redis keys so a run never clobbers dev quotes. */
  redisPrefix: isTest ? 'test:' : '',
  quoteSigningSecret: required('QUOTE_SIGNING_SECRET'),
  quoteTtlSeconds: 120,
} as const;
