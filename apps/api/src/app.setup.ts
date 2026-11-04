import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import { ProblemDetailsFilter } from './common/problem-details.filter';

// Shared by main.ts and the e2e tests so both run the same configuration.
export function configureApp(app: INestApplication): void {
  app.setGlobalPrefix('v1', { exclude: ['health/live', 'health/ready'] });
  app.use(cookieParser());
  app.useGlobalFilters(new ProblemDetailsFilter());
}
