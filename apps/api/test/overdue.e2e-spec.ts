import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { OverdueService } from '../src/jobs/overdue.service';
import {
  createAdminPool,
  createAppPool,
  deleteOrganizations,
} from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

const ASOF = '2026-04-01';

describe('Overdue sweep (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let appPool: Pool;
  let overdue: OverdueService;
  let token: string;
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function createOrg(name: string): Promise<string> {
    const res = await http()
      .post('/v1/orgs')
      .set(auth())
      .send({ name })
      .expect(201);
    orgIds.push(res.body.id);
    return res.body.id;
  }

  async function invoice(orgId: string, dueDate: string, send: boolean) {
    const client = await http()
      .post(`/v1/orgs/${orgId}/clients`)
      .set(auth())
      .send({ name: 'Client' })
      .expect(201);
    const draft = await http()
      .post(`/v1/orgs/${orgId}/invoices`)
      .set(auth())
      .send({
        clientId: client.body.id,
        issueDate: '2026-03-01',
        dueDate,
        lineItems: [
          {
            description: 'Work',
            quantity: '1',
            unitPriceCents: 1000,
            taxRateBps: 0,
          },
        ],
      })
      .expect(201);
    if (send) {
      await http()
        .post(`/v1/orgs/${orgId}/invoices/${draft.body.id}/send`)
        .set(auth())
        .expect(200);
    }
    return draft.body.id as string;
  }

  const statusOf = async (orgId: string, id: string) =>
    (
      await http()
        .get(`/v1/orgs/${orgId}/invoices/${id}`)
        .set(auth())
        .expect(200)
    ).body.status as string;

  let orgA: string;
  let orgB: string;
  let orgC: string;
  let aDue: string;
  let aFuture: string;
  let aDraft: string;
  let bFuture: string;

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
    appPool = createAppPool();
    overdue = t.app.get(OverdueService);
    const user = await registerAndLogin(t);
    userEmails.push(user.email);
    token = user.accessToken;

    orgA = await createOrg(`Overdue A ${randomUUID()}`);
    orgB = await createOrg(`Overdue B ${randomUUID()}`);
    orgC = await createOrg(`Overdue C ${randomUUID()}`);
    aDue = await invoice(orgA, '2026-03-31', true); // past due
    aFuture = await invoice(orgA, '2027-01-31', true); // not due yet
    aDraft = await invoice(orgA, '2026-03-31', false); // drafts never go overdue
    bFuture = await invoice(orgB, '2027-01-31', true);
    await invoice(orgC, '2026-03-31', false); // only a draft
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await appPool.end();
    await t.app.close();
  });

  it('discovers only orgs that have a sent invoice past its due date', async () => {
    const found = await overdue.findOrgsWithOverdueInvoices(ASOF);
    expect(found).toContain(orgA);
    expect(found).not.toContain(orgB); // sent, but not due yet
    expect(found).not.toContain(orgC); // past due, but only a draft
  });

  it('treats the due date itself as not yet overdue', async () => {
    expect(
      await overdue.findOrgsWithOverdueInvoices('2026-03-31'),
    ).not.toContain(orgA);
    expect(await overdue.findOrgsWithOverdueInvoices('2026-04-01')).toContain(
      orgA,
    );
  });

  it('marks only due sent invoices, only in its own org, and is idempotent', async () => {
    expect(await overdue.markOverdue(orgA, ASOF)).toBe(1);
    expect(await statusOf(orgA, aDue)).toBe('overdue');
    expect(await statusOf(orgA, aFuture)).toBe('sent');
    expect(await statusOf(orgA, aDraft)).toBe('draft');

    expect(await overdue.markOverdue(orgA, ASOF)).toBe(0); // repeat is a no-op
    expect(await overdue.markOverdue(orgB, ASOF)).toBe(0); // nothing due in B
    expect(await statusOf(orgB, bFuture)).toBe('sent');
    expect(await overdue.findOrgsWithOverdueInvoices(ASOF)).not.toContain(orgA);
  });

  it('lets an overdue invoice still be voided', async () => {
    const res = await http()
      .post(`/v1/orgs/${orgA}/invoices/${aDue}/void`)
      .set(auth())
      .expect(200);
    expect(res.body.status).toBe('void');
  });

  it('keeps the runtime role blind across tenants', async () => {
    const rows = await appPool.query('SELECT count(*)::int AS n FROM invoices');
    expect(rows.rows[0].n).toBe(0); // no tenant context, so no rows
  });

  it('exposes the discovery function to the app role only', async () => {
    const meta = await admin.query(
      `SELECT prosecdef,
              has_function_privilege('app_user', 'public.app_orgs_with_overdue_invoices(date)', 'EXECUTE') AS app_user_can,
              has_function_privilege('public', 'public.app_orgs_with_overdue_invoices(date)', 'EXECUTE') AS public_can
       FROM pg_proc WHERE proname = 'app_orgs_with_overdue_invoices'`,
    );
    expect(meta.rows[0]).toEqual({
      prosecdef: true,
      app_user_can: true,
      public_can: false,
    });
  });
});
