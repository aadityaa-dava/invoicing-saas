import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from './../src/app.module';
import { configureApp } from './../src/app.setup';
import { REDIS } from './../src/redis/redis.module';
import { createTestApp, TestApp } from './support/test-app';

describe('Health (e2e)', () => {
  let t: TestApp;
  const http = () => request(t.app.getHttpServer());

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('GET /health/live returns ok outside the /v1 prefix', async () => {
    await http().get('/health/live').expect(200).expect({ status: 'ok' });
  });

  it('GET /health/ready reports the database and Redis as up', async () => {
    await http()
      .get('/health/ready')
      .expect(200)
      .expect({ status: 'ok', checks: { database: 'up', redis: 'up' } });
  });

  it('returns 404 for unknown routes', async () => {
    await http().get('/v1/nope').expect(404);
  });

  it('readiness fails with 503 when Redis is down, but liveness stays ok', async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(REDIS)
      .useValue({
        ping: () => Promise.reject(new Error('redis is down')),
        quit: async () => 'OK',
      })
      .compile();
    const app = moduleFixture.createNestApplication();
    configureApp(app);
    await app.init();

    const ready = await request(app.getHttpServer()).get('/health/ready');
    expect(ready.status).toBe(503);
    await request(app.getHttpServer()).get('/health/live').expect(200);

    await app.close();
  });
});
