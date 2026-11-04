import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';

describe('Health (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /health/live returns ok outside the /v1 prefix', () => {
    return request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('GET /health/ready reports the database as up', () => {
    return request(app.getHttpServer())
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ok', checks: { database: 'up' } });
  });

  it('returns 404 for unknown routes', () => {
    return request(app.getHttpServer()).get('/v1/nope').expect(404);
  });
});
