import type { Pool } from 'pg';
import request from 'supertest';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

// Configuration is read once per test file, so "no paid plan configured" needs
// its own file.
describe('Billing without a configured price (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let orgId: string;
  let email: string;
  let token: string;
  const http = () => request(t.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    // An empty value counts as unset, whatever a local .env file contains.
    process.env.STRIPE_PRICE_PRO = '';
    t = await createTestApp();
    admin = createAdminPool();
    const user = await registerAndLogin(t);
    email = user.email;
    token = user.accessToken;
    const org = await http()
      .post('/v1/orgs')
      .set(auth())
      .send({ name: 'No Price Co' })
      .expect(201);
    orgId = org.body.id;
  });

  afterAll(async () => {
    await deleteOrganizations(admin, [orgId]);
    await admin.query('DELETE FROM users WHERE email = $1', [email]);
    await admin.end();
    await t.app.close();
  });

  it('answers 503 with a clear code and creates nothing at Stripe', async () => {
    const res = await http()
      .post(`/v1/orgs/${orgId}/billing/checkout-session`)
      .set(auth())
      .expect(503);
    expect(res.body.code).toBe('billing_not_configured');
    expect(t.stripe.customers).toHaveLength(0);
  });

  it('still reports the free plan', async () => {
    const res = await http()
      .get(`/v1/orgs/${orgId}/billing`)
      .set(auth())
      .expect(200);
    expect(res.body.plan).toBe('free');
  });
});
