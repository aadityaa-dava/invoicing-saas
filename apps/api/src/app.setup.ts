import type { INestApplication } from '@nestjs/common';

// Shared by main.ts and the e2e tests so both run the same configuration.
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
}
