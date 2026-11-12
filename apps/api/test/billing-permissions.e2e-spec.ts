import type { Pool } from 'pg';
import request from 'supertest';
import {
  addMember,
  createAdminPool,
  deleteOrganizations,
} from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

type Role = 'owner' | 'admin' | 'member' | 'viewer' | 'outsider';
const ROLES: Role[] = ['owner', 'admin', 'member', 'viewer', 'outsider'];

describe('Billing and payment link permissions by role (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let orgId: string;
  let invoiceId: string;
  const ids = {} as Record<Role, string>;
  const tokens = {} as Record<Role, string>;
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const as = (role: Role) => ({ Authorization: `Bearer ${tokens[role]}` });

  beforeAll(async () => {
    process.env.STRIPE_PRICE_PRO = 'price_testpro0000000';
    t = await createTestApp();
    admin = createAdminPool();

    for (const role of ROLES) {
      const user = await registerAndLogin(t);
      userEmails.push(user.email);
      tokens[role] = user.accessToken;
      const me = await http().get('/v1/me').set(as(role)).expect(200);
      ids[role] = me.body.id as string;
    }

    const org = await http()
      .post('/v1/orgs')
      .set(as('owner'))
      .send({ name: 'Permissions Co' })
      .expect(201);
    orgId = org.body.id;
    orgIds.push(orgId);
    await addMember(admin, orgId, ids.admin, 'admin');
    await addMember(admin, orgId, ids.member, 'member');
    await addMember(admin, orgId, ids.viewer, 'viewer');

    const client = await http()
      .post(`/v1/orgs/${orgId}/clients`)
      .set(as('owner'))
      .send({ name: 'Globex' })
      .expect(201);
    const draft = await http()
      .post(`/v1/orgs/${orgId}/invoices`)
      .set(as('owner'))
      .send({
        clientId: client.body.id,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lineItems: [
          {
            description: 'Work',
            quantity: '1',
            unitPriceCents: 5000,
            taxRateBps: 0,
          },
        ],
      })
      .expect(201);
    invoiceId = draft.body.id;
    await http()
      .post(`/v1/orgs/${orgId}/invoices/${invoiceId}/send`)
      .set(as('owner'))
      .expect(200);
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await t.app.close();
  });

  describe('billing is owner only', () => {
    const denied: Role[] = ['admin', 'member', 'viewer'];

    it.each(denied)('%s cannot read billing', async (role) => {
      await http().get(`/v1/orgs/${orgId}/billing`).set(as(role)).expect(403);
    });

    it.each(denied)('%s cannot start a checkout', async (role) => {
      await http()
        .post(`/v1/orgs/${orgId}/billing/checkout-session`)
        .set(as(role))
        .expect(403);
    });

    it.each(denied)('%s cannot open the portal', async (role) => {
      await http()
        .post(`/v1/orgs/${orgId}/billing/portal-session`)
        .set(as(role))
        .expect(403);
    });

    it('the owner can do all three', async () => {
      await http()
        .get(`/v1/orgs/${orgId}/billing`)
        .set(as('owner'))
        .expect(200);
      await http()
        .post(`/v1/orgs/${orgId}/billing/checkout-session`)
        .set(as('owner'))
        .expect(201);
      await http()
        .post(`/v1/orgs/${orgId}/billing/portal-session`)
        .set(as('owner'))
        .expect(201);
    });

    it('denied roles created no Stripe objects', () => {
      expect(t.stripe.customers.filter((c) => c.orgId === orgId)).toHaveLength(
        1,
      );
    });
  });

  describe('payment links follow invoice:send', () => {
    it.each(['owner', 'admin', 'member'] as Role[])(
      '%s can create one',
      async (role) => {
        await http()
          .post(`/v1/orgs/${orgId}/invoices/${invoiceId}/payment-link`)
          .set(as(role))
          .expect(201);
      },
    );

    it('a viewer cannot', async () => {
      const before = t.stripe.invoiceCheckouts.length;
      await http()
        .post(`/v1/orgs/${orgId}/invoices/${invoiceId}/payment-link`)
        .set(as('viewer'))
        .expect(403);
      expect(t.stripe.invoiceCheckouts.length).toBe(before);
    });
  });

  describe('everyone outside the organization', () => {
    const routes: [string, string][] = [
      ['get', 'billing'],
      ['post', 'billing/checkout-session'],
      ['post', 'billing/portal-session'],
    ];

    it.each(routes)('gets 404 for %s %s', async (method, path) => {
      const call =
        method === 'get'
          ? http().get(`/v1/orgs/${orgId}/${path}`)
          : http().post(`/v1/orgs/${orgId}/${path}`);
      await call.set(as('outsider')).expect(404);
    });

    it('gets 404 for the payment link', async () => {
      await http()
        .post(`/v1/orgs/${orgId}/invoices/${invoiceId}/payment-link`)
        .set(as('outsider'))
        .expect(404);
    });

    it('and unauthenticated calls get 401', async () => {
      await http().get(`/v1/orgs/${orgId}/billing`).expect(401);
      await http()
        .post(`/v1/orgs/${orgId}/invoices/${invoiceId}/payment-link`)
        .expect(401);
    });
  });
});
