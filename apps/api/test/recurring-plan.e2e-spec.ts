import type { Pool } from 'pg';
import request from 'supertest';
import { RecurringGenerationService } from '../src/jobs/recurring-generation.service';
import {
  createAdminPool,
  deleteOrganizations,
  grantPaidPlan,
  setSubscriptionStatus,
} from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

describe('Recurring invoices and the paid plan (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let gen: RecurringGenerationService;
  let token: string;
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function newOrg(name: string, paid: boolean) {
    const org = await http()
      .post('/v1/orgs')
      .set(auth())
      .send({ name })
      .expect(201);
    orgIds.push(org.body.id);
    if (paid) await grantPaidPlan(admin, org.body.id);
    const client = await http()
      .post(`/v1/orgs/${org.body.id}/clients`)
      .set(auth())
      .send({ name: 'Client' })
      .expect(201);
    return { orgId: org.body.id as string, clientId: client.body.id as string };
  }

  const create = (o: { orgId: string; clientId: string }, startDate: string) =>
    http()
      .post(`/v1/orgs/${o.orgId}/recurring-invoices`)
      .set(auth())
      .send({
        clientId: o.clientId,
        name: 'Retainer',
        frequency: 'monthly',
        startDate,
        lineItems: [
          {
            description: 'Retainer',
            quantity: '1',
            unitPriceCents: 10000,
            taxRateBps: 0,
          },
        ],
      });

  const resume = (orgId: string, id: string) =>
    http()
      .patch(`/v1/orgs/${orgId}/recurring-invoices/${id}`)
      .set(auth())
      .send({ active: true });

  const templateOf = async (orgId: string, id: string) =>
    (
      await http()
        .get(`/v1/orgs/${orgId}/recurring-invoices/${id}`)
        .set(auth())
        .expect(200)
    ).body as { active: boolean };

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
    gen = t.app.get(RecurringGenerationService);
    const user = await registerAndLogin(t);
    userEmails.push(user.email);
    token = user.accessToken;
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await t.app.close();
  });

  it('refuses to create a template on the free plan', async () => {
    const free = await newOrg('Free Co', false);
    const res = await create(free, '2035-01-31').expect(402);
    expect(res.body.code).toBe('plan_required');

    const list = await http()
      .get(`/v1/orgs/${free.orgId}/recurring-invoices`)
      .set(auth())
      .expect(200);
    expect(list.body).toEqual([]);
  });

  describe('when the plan lapses and comes back', () => {
    let o: { orgId: string; clientId: string };
    let due: string;
    let later: string;

    beforeAll(async () => {
      o = await newOrg('Paid Co', true);
      due = (await create(o, '2035-01-31').expect(201)).body.id;
      later = (await create(o, '2036-06-01').expect(201)).body.id;
      await setSubscriptionStatus(admin, o.orgId, 'canceled');
    });

    it('pauses a due template instead of generating or skipping it', async () => {
      const result = await gen.generateForOrg(o.orgId, '2035-02-01');
      expect(result).toEqual({ templates: 0, invoices: 0 });

      expect((await templateOf(o.orgId, due)).active).toBe(false);
      const invoices = await http()
        .get(`/v1/orgs/${o.orgId}/invoices`)
        .set(auth())
        .expect(200);
      expect(invoices.body).toHaveLength(0);
    });

    it('leaves a template that is not due yet running', async () => {
      expect((await templateOf(o.orgId, later)).active).toBe(true);
    });

    it('no longer lists the organization as having due work', async () => {
      expect(await gen.findOrgsWithDueTemplates('2035-02-01')).not.toContain(
        o.orgId,
      );
    });

    it('refuses to resume while the plan is lapsed', async () => {
      const res = await resume(o.orgId, due).expect(402);
      expect(res.body.code).toBe('plan_required');
      expect((await templateOf(o.orgId, due)).active).toBe(false);
    });

    it('resumes after upgrading and generates again', async () => {
      await setSubscriptionStatus(admin, o.orgId, 'active');
      const res = await resume(o.orgId, due).expect(200);
      expect(res.body.active).toBe(true);

      const result = await gen.generateForOrg(o.orgId, '2035-02-01');
      expect(result).toEqual({ templates: 1, invoices: 1 });
    });
  });
});
