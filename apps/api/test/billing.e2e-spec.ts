import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

const PRO_PRICE = 'price_testpro0000000';

describe('Organization billing (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  const orgIds: string[] = [];
  const userEmails: string[] = [];
  const http = () => request(t.app.getHttpServer());

  let token: string;
  let orgId: string;
  let outsiderToken: string;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function newOrg(name: string) {
    const user = await registerAndLogin(t);
    userEmails.push(user.email);
    const org = await http()
      .post('/v1/orgs')
      .set({ Authorization: `Bearer ${user.accessToken}` })
      .send({ name })
      .expect(201);
    orgIds.push(org.body.id);
    return { token: user.accessToken, orgId: org.body.id as string };
  }

  async function inOrg(sql: string, params: unknown[] = []) {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      await client.query(sql, params);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const billing = () => http().get(`/v1/orgs/${orgId}/billing`).set(auth());
  const checkout = () =>
    http().post(`/v1/orgs/${orgId}/billing/checkout-session`).set(auth());
  const portal = () =>
    http().post(`/v1/orgs/${orgId}/billing/portal-session`).set(auth());
  const customersOfOrg = () =>
    t.stripe.customers.filter((c) => c.orgId === orgId);

  beforeAll(async () => {
    process.env.STRIPE_PRICE_PRO = PRO_PRICE;
    t = await createTestApp();
    admin = createAdminPool();
    ({ token, orgId } = await newOrg('Billing Co'));
    ({ token: outsiderToken } = await newOrg('Outsider Co'));
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await t.app.close();
  });

  it('starts on the free plan with no billing account', async () => {
    const res = await billing().expect(200);
    expect(res.body).toEqual({
      plan: 'free',
      status: null,
      currentPeriodEnd: null,
      cancelAtPeriodEnd: false,
      hasBillingAccount: false,
    });
  });

  it('has no portal until a billing account exists', async () => {
    const res = await portal().expect(409);
    expect(res.body.code).toBe('no_billing_account');
  });

  it('creates the Stripe customer and a subscription checkout', async () => {
    const res = await checkout().expect(201);
    expect(res.body.url).toMatch(
      /^https:\/\/checkout\.stripe\.test\/subscribe\//,
    );

    expect(customersOfOrg()).toHaveLength(1);
    expect(customersOfOrg()[0].name).toBe('Billing Co');
    const session = t.stripe.subscriptionCheckouts.at(-1)!;
    expect(session.orgId).toBe(orgId);
    expect(session.priceId).toBe(PRO_PRICE);
    expect(session.customerId).toBe(customersOfOrg()[0].id);
    expect(session.successUrl).toContain('/billing/success');
  });

  it('reuses the customer and the session on a repeat request', async () => {
    const before = t.stripe.subscriptionCheckouts.length;
    const first = await checkout().expect(201);
    const second = await checkout().expect(201);

    expect(second.body.url).toBe(first.body.url);
    expect(customersOfOrg()).toHaveLength(1);
    expect(t.stripe.subscriptionCheckouts.length).toBeLessThanOrEqual(
      before + 1,
    );
  });

  it('now reports a billing account, still on the free plan', async () => {
    const res = await billing().expect(200);
    expect(res.body.hasBillingAccount).toBe(true);
    expect(res.body.plan).toBe('free');
  });

  it('opens the customer portal for the stored customer', async () => {
    const res = await portal().expect(201);
    expect(res.body.url).toContain(customersOfOrg()[0].id);
    expect(t.stripe.portalSessions.at(-1)!.returnUrl).toMatch(/\/billing$/);
  });

  it('reports the paid plan once a subscription is active', async () => {
    await inOrg(
      `INSERT INTO subscriptions
         (id, org_id, plan, status, stripe_subscription_id, current_period_end, updated_at)
       VALUES (gen_random_uuid(), $1::uuid, 'pro', 'active', $2, now() + interval '30 days', now())`,
      [orgId, `sub_test_${randomUUID().replaceAll('-', '')}`],
    );
    const res = await billing().expect(200);
    expect(res.body.plan).toBe('pro');
    expect(res.body.status).toBe('active');
    expect(res.body.currentPeriodEnd).not.toBeNull();
  });

  it('refuses a second checkout while subscribed', async () => {
    const res = await checkout().expect(409);
    expect(res.body.code).toBe('already_subscribed');
  });

  it('keeps the paid plan while past due and drops it when canceled', async () => {
    await inOrg(
      "UPDATE subscriptions SET status = 'past_due' WHERE org_id = $1::uuid",
      [orgId],
    );
    expect((await billing().expect(200)).body.plan).toBe('pro');

    await inOrg(
      "UPDATE subscriptions SET status = 'canceled' WHERE org_id = $1::uuid",
      [orgId],
    );
    const res = await billing().expect(200);
    expect(res.body.plan).toBe('free');
    expect(res.body.status).toBe('canceled');
  });

  it('hides the organization from a non-member', async () => {
    const outsider = { Authorization: `Bearer ${outsiderToken}` };
    await http().get(`/v1/orgs/${orgId}/billing`).set(outsider).expect(404);
    await http()
      .post(`/v1/orgs/${orgId}/billing/checkout-session`)
      .set(outsider)
      .expect(404);
  });

  it('requires authentication', async () => {
    await http().get(`/v1/orgs/${orgId}/billing`).expect(401);
    await http().post(`/v1/orgs/${orgId}/billing/portal-session`).expect(401);
  });
});
