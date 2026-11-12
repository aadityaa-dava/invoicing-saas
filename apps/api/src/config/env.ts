import { z } from 'zod';

const boolFlag = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');

// An empty value counts as unset, so a copied .env.example boots without Stripe.
const optionalPattern = (pattern: RegExp, message: string) =>
  z.preprocess(
    (value) => (value === '' ? undefined : value),
    z.string().regex(pattern, message).optional(),
  );

const envSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  WEB_URL: z.string().url().default('http://localhost:3001'),
  JWT_ACCESS_SECRET: z.string().min(32),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(7),
  SMTP_HOST: z.string().min(1).default('localhost'),
  SMTP_PORT: z.coerce.number().int().positive().default(1025),
  SMTP_SECURE: boolFlag('false'),
  SMTP_USER: z.string().min(1).optional(),
  SMTP_PASSWORD: z.string().min(1).optional(),
  MAIL_FROM: z.string().min(3).default('Invoicing <no-reply@invoicing.local>'),
  // Set to false to run the API without consuming background jobs.
  RUN_WORKERS: boolFlag('true'),
  // Redis key namespace for queues. Tests give each suite its own.
  QUEUE_PREFIX: z.string().min(1).default('bull'),
  // Test mode only. A live key is refused at startup, see ADR-0007.
  STRIPE_SECRET_KEY: optionalPattern(
    /^sk_test_[A-Za-z0-9]{8,}$/,
    'must be a Stripe test-mode secret key (sk_test_...)',
  ),
  STRIPE_WEBHOOK_SECRET: optionalPattern(
    /^whsec_[A-Za-z0-9]{8,}$/,
    'must be a Stripe webhook signing secret (whsec_...)',
  ),
  // Id of the paid plan's recurring price, created in the Stripe test dashboard.
  STRIPE_PRICE_PRO: optionalPattern(
    /^price_[A-Za-z0-9]{8,}$/,
    'must be a Stripe price id (price_...)',
  ),
});

export type Env = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration: ${problems}`);
  }
  return result.data;
}
