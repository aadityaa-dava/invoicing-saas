import { defineConfig, env } from 'prisma/config';

// Load the monorepo-root .env locally. In CI there is no file and the
// variables come from the real environment.
try {
  process.loadEnvFile('../../.env');
} catch {
  // no .env file, use the process environment
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: {
    // Migrations run as app_owner. The running API uses DATABASE_URL (app_user).
    url: env('MIGRATION_DATABASE_URL'),
  },
});
