import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { RecurringGenerationService } from '../src/jobs/recurring-generation.service';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

interface Org {
  orgId: string;
  clientId: string;
}

describe('Recurring invoice generation (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let gen: RecurringGenerationService;
  let token: string;
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function newOrg(clientEmail?: string): Promise<Org> {
    const org = await http()
      .post('/v1/orgs')
      .set(auth())
      .send({ name: `Gen ${randomUUID()}` })
      .expect(201);
    orgIds.push(org.body.id);
    const client = await http()
      .post(`/v1/orgs/${org.body.id}/clients`)
      .set(auth())
      .send({ name: 'Client', ...(clientEmail ? { email: clientEmail } : {}) })
      .expect(201);
    return { orgId: org.body.id, clientId: client.body.id };
  }

  const template = async (o: Org, over: Record<string, unknown> = {}) =>
    (
      await http()
        .post(`/v1/orgs/${o.orgId}/recurring-invoices`)
        .set(auth())
        .send({
          clientId: o.clientId,
          name: 'Retainer',
          frequency: 'monthly',
          startDate: '2035-01-31',
          dueInDays: 14,
          lineItems: [
            {
              description: 'Retainer',
              quantity: '2.5',
              unitPriceCents: 4000,
              taxRateBps: 825,
            },
          ],
          ...over,
        })
        .expect(201)
    ).body as { id: string };

  const getTemplate = async (o: Org, id: string) =>
    (
      await http()
        .get(`/v1/orgs/${o.orgId}/recurring-invoices/${id}`)
        .set(auth())
        .expect(200)
    ).body;

  const generated = async (templateId: string) =>
    (
      await admin.query(
        `SELECT id, number, status, issue_date::text AS issue, due_date::text AS due,
                subtotal_cents::int AS subtotal, tax_cents::int AS tax,
                total_cents::int AS total, recurring_run_on::text AS run
         FROM invoices WHERE recurring_template_id = $1 ORDER BY recurring_run_on`,
        [templateId],
      )
    ).rows as {
      id: string;
      number: string | null;
      status: string;
      issue: string;
      due: string;
      subtotal: number;
      tax: number;
      total: number;
      run: string;
    }[];

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

  it('discovers only orgs with an active, due, live template', async () => {
    const [a, b, c, d] = [
      await newOrg(),
      await newOrg(),
      await newOrg(),
      await newOrg(),
    ];
    await template(a); // due on 2035-01-31
    await template(b, { startDate: '2036-01-01' }); // not due yet
    const paused = await template(c);
    await http()
      .patch(`/v1/orgs/${c.orgId}/recurring-invoices/${paused.id}`)
      .set(auth())
      .send({ active: false })
      .expect(200);
    const removed = await template(d);
    await http()
      .delete(`/v1/orgs/${d.orgId}/recurring-invoices/${removed.id}`)
      .set(auth())
      .expect(204);

    const found = await gen.findOrgsWithDueTemplates('2035-06-01');
    expect(found).toContain(a.orgId);
    expect(found).not.toContain(b.orgId);
    expect(found).not.toContain(c.orgId);
    expect(found).not.toContain(d.orgId);
  });

  it('generates a draft invoice from the template and advances it', async () => {
    const o = await newOrg();
    const tpl = await template(o);
    expect(await gen.generateForOrg(o.orgId, '2035-01-31')).toEqual({
      templates: 1,
      invoices: 1,
    });

    const [inv] = await generated(tpl.id);
    expect(inv).toMatchObject({
      status: 'draft',
      number: null,
      issue: '2035-01-31',
      due: '2035-02-14', // run date + dueInDays
      run: '2035-01-31',
      subtotal: 10000, // 2.5 x 4000
      tax: 825,
      total: 10825,
    });
    expect(await getTemplate(o, tpl.id)).toMatchObject({
      runCount: 1,
      nextRunOn: '2035-02-28',
    });
  });

  it('catches up missed runs, dated for their own run date, and is idempotent', async () => {
    const o = await newOrg();
    const tpl = await template(o);
    expect(await gen.generateForOrg(o.orgId, '2035-06-01')).toEqual({
      templates: 1,
      invoices: 5,
    });
    expect((await generated(tpl.id)).map((i) => i.issue)).toEqual([
      '2035-01-31',
      '2035-02-28',
      '2035-03-31',
      '2035-04-30',
      '2035-05-31',
    ]);
    expect(await getTemplate(o, tpl.id)).toMatchObject({
      runCount: 5,
      nextRunOn: '2035-06-30',
    });

    expect(await gen.generateForOrg(o.orgId, '2035-06-01')).toEqual({
      templates: 0,
      invoices: 0,
    });
    expect(await generated(tpl.id)).toHaveLength(5);
  });

  it('caps catch-up per tick and continues on the next one', async () => {
    const o = await newOrg();
    const tpl = await template(o, {
      frequency: 'weekly',
      startDate: '2035-01-01',
    });
    expect(await gen.generateForOrg(o.orgId, '2035-12-31', 3)).toEqual({
      templates: 1,
      invoices: 3,
    });
    expect(await getTemplate(o, tpl.id)).toMatchObject({
      runCount: 3,
      nextRunOn: '2035-01-22',
    });
    expect(await gen.generateForOrg(o.orgId, '2035-12-31', 3)).toEqual({
      templates: 1,
      invoices: 3,
    });
    expect(await getTemplate(o, tpl.id)).toMatchObject({
      runCount: 6,
      nextRunOn: '2035-02-12',
    });
  });

  it('stops at the end date', async () => {
    const o = await newOrg();
    const tpl = await template(o, { endDate: '2035-03-15' });
    expect(await gen.generateForOrg(o.orgId, '2035-12-31')).toEqual({
      templates: 1,
      invoices: 2,
    });
    expect((await generated(tpl.id)).map((i) => i.issue)).toEqual([
      '2035-01-31',
      '2035-02-28',
    ]);
    expect(await getTemplate(o, tpl.id)).toMatchObject({
      runCount: 2,
      nextRunOn: null,
    });
    expect(await gen.generateForOrg(o.orgId, '2036-12-31')).toEqual({
      templates: 0,
      invoices: 0,
    });
  });

  it('generates nothing for paused, deleted, future or client-less templates', async () => {
    const o = await newOrg();
    const paused = await template(o);
    await http()
      .patch(`/v1/orgs/${o.orgId}/recurring-invoices/${paused.id}`)
      .set(auth())
      .send({ active: false })
      .expect(200);
    const removed = await template(o);
    await http()
      .delete(`/v1/orgs/${o.orgId}/recurring-invoices/${removed.id}`)
      .set(auth())
      .expect(204);
    await template(o, { startDate: '2036-01-01' });
    expect(await gen.generateForOrg(o.orgId, '2035-06-01')).toEqual({
      templates: 0,
      invoices: 0,
    });

    const o2 = await newOrg();
    const orphan = await template(o2);
    await http()
      .delete(`/v1/orgs/${o2.orgId}/clients/${o2.clientId}`)
      .set(auth())
      .expect(204);
    expect(await gen.generateForOrg(o2.orgId, '2035-06-01')).toEqual({
      templates: 0,
      invoices: 0,
    });
    // nothing was lost: the schedule did not move
    expect(await getTemplate(o2, orphan.id)).toMatchObject({
      runCount: 0,
      nextRunOn: '2035-01-31',
    });
  });

  it('sends automatically only when the template asks for it', async () => {
    const o = await newOrg(`billing-${randomUUID()}@client.test`);
    const manual = await template(o, { autoSend: false });
    const auto = await template(o, { autoSend: true });
    await gen.generateForOrg(o.orgId, '2035-01-31');

    expect((await generated(manual.id))[0].status).toBe('draft');
    const [sent] = await generated(auto.id);
    expect(sent.status).toBe('sent');
    expect(sent.number).toMatch(/^INV-\d{6}$/);
    expect(t.mail.invoiceEmails.map((e) => e.invoiceId)).toContain(sent.id);
  });

  it('never duplicates a run when two jobs race', async () => {
    const o = await newOrg();
    const tpl = await template(o);
    const [r1, r2] = await Promise.all([
      gen.generateForOrg(o.orgId, '2035-03-31'),
      gen.generateForOrg(o.orgId, '2035-03-31'),
    ]);
    expect(r1.invoices + r2.invoices).toBe(3); // Jan, Feb, Mar: each exactly once
    expect(await generated(tpl.id)).toHaveLength(3);
    expect(await getTemplate(o, tpl.id)).toMatchObject({ runCount: 3 });
  }, 20_000);

  it('skips a template that is locked instead of waiting, then generates it later', async () => {
    const o = await newOrg();
    const tpl = await template(o);
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(
        'SELECT id FROM recurring_templates WHERE id = $1 FOR UPDATE',
        [tpl.id],
      );
      const started = Date.now();
      expect(await gen.generateForOrg(o.orgId, '2035-01-31')).toEqual({
        templates: 0,
        invoices: 0,
      });
      expect(Date.now() - started).toBeLessThan(3000); // did not wait on the lock
      // read on the holder's own connection: the admin pool's slot is in use
      const during = await holder.query(
        'SELECT count(*)::int AS n FROM invoices WHERE recurring_template_id = $1',
        [tpl.id],
      );
      expect(during.rows[0].n).toBe(0);
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
    expect(await gen.generateForOrg(o.orgId, '2035-01-31')).toEqual({
      templates: 1,
      invoices: 1,
    });
  }, 20_000);

  it('heals a run that already has an invoice instead of duplicating it', async () => {
    const o = await newOrg();
    const tpl = await template(o);
    const insert = () =>
      admin.query(
        `INSERT INTO invoices (id, org_id, client_id, issue_date, due_date, updated_at,
                               recurring_template_id, recurring_run_on)
         VALUES (gen_random_uuid(), $1, $2, '2035-01-31', '2035-02-14', now(), $3, '2035-01-31')`,
        [o.orgId, o.clientId, tpl.id],
      );
    await insert();
    // the database itself refuses a second invoice for the same run
    await expect(insert()).rejects.toMatchObject({ code: '23505' });

    expect(await gen.generateForOrg(o.orgId, '2035-01-31')).toEqual({
      templates: 0,
      invoices: 0,
    });
    expect(await generated(tpl.id)).toHaveLength(1);
    expect(await getTemplate(o, tpl.id)).toMatchObject({
      runCount: 1,
      nextRunOn: '2035-02-28',
    });
  });

  it('exposes the discovery function to the app role only', async () => {
    const meta = await admin.query(
      `SELECT prosecdef,
              has_function_privilege('app_user', 'public.app_orgs_with_due_recurring(date)', 'EXECUTE') AS app_user_can,
              has_function_privilege('public', 'public.app_orgs_with_due_recurring(date)', 'EXECUTE') AS public_can
       FROM pg_proc WHERE proname = 'app_orgs_with_due_recurring'`,
    );
    expect(meta.rows[0]).toEqual({
      prosecdef: true,
      app_user_can: true,
      public_can: false,
    });
  });
});
