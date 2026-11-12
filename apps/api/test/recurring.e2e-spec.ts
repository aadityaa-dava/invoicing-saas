import type { Pool } from 'pg';
import request from 'supertest';
import { RecurringService } from '../src/recurring/recurring.service';
import {
  addMember,
  createAdminPool,
  createAppPool,
  deleteOrganizations,
  grantPaidPlan,
} from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

type Role = 'owner' | 'member' | 'viewer' | 'outsider';

describe('Recurring invoice templates (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let appPool: Pool;
  let service: RecurringService;
  let orgId: string;
  let otherOrgId: string;
  let clientId: string;
  let otherClientId: string;
  const ids = {} as Record<Role, string>;
  const tokens = {} as Record<Role, string>;
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const base = () => `/v1/orgs/${orgId}/recurring-invoices`;

  async function createUser() {
    const u = await registerAndLogin(t);
    userEmails.push(u.email);
    const me = await http().get('/v1/me').set(auth(u.accessToken)).expect(200);
    return { token: u.accessToken, id: me.body.id as string };
  }

  async function orgWithClient(token: string, name: string) {
    const org = await http()
      .post('/v1/orgs')
      .set(auth(token))
      .send({ name })
      .expect(201);
    orgIds.push(org.body.id);
    await grantPaidPlan(admin, org.body.id);
    const client = await http()
      .post(`/v1/orgs/${org.body.id}/clients`)
      .set(auth(token))
      .send({ name: `${name} client` })
      .expect(201);
    return { orgId: org.body.id as string, clientId: client.body.id as string };
  }

  const body = (over: Record<string, unknown> = {}) => ({
    clientId,
    name: 'Retainer',
    frequency: 'monthly',
    startDate: '2035-01-31',
    dueInDays: 14,
    lineItems: [
      {
        description: 'Retainer',
        quantity: '1',
        unitPriceCents: 150000,
        taxRateBps: 0,
      },
    ],
    ...over,
  });
  const create = (token: string, over: Record<string, unknown> = {}) =>
    http().post(base()).set(auth(token)).send(body(over));

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
    appPool = createAppPool();
    service = t.app.get(RecurringService);

    for (const role of ['owner', 'member', 'viewer', 'outsider'] as const) {
      const u = await createUser();
      tokens[role] = u.token;
      ids[role] = u.id;
    }
    ({ orgId, clientId } = await orgWithClient(tokens.owner, 'Recurring Co'));
    ({ orgId: otherOrgId, clientId: otherClientId } = await orgWithClient(
      tokens.outsider,
      'Other Co',
    ));
    await addMember(admin, orgId, ids.member, 'member');
    await addMember(admin, orgId, ids.viewer, 'viewer');
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

  it('creates a template whose first run is its start date', async () => {
    const res = await create(tokens.owner).expect(201);
    expect(res.body).toMatchObject({
      clientId,
      name: 'Retainer',
      currency: 'USD',
      frequency: 'monthly',
      startDate: '2035-01-31',
      endDate: null,
      nextRunOn: '2035-01-31',
      runCount: 0,
      dueInDays: 14,
      autoSend: false,
      active: true,
    });
    expect(res.body.lineItems).toEqual([
      {
        position: 1,
        description: 'Retainer',
        quantity: '1',
        unitPriceCents: 150000,
        taxRateBps: 0,
      },
    ]);
  });

  it('enforces permissions by role', async () => {
    await create(tokens.member).expect(201);
    await create(tokens.viewer).expect(403);
    const list = await http().get(base()).set(auth(tokens.viewer)).expect(200);
    expect(list.body.length).toBeGreaterThan(0); // viewers may read
    const id = list.body[0].id;
    await http()
      .patch(`${base()}/${id}`)
      .set(auth(tokens.viewer))
      .send({ name: 'x' })
      .expect(403);
    await http().delete(`${base()}/${id}`).set(auth(tokens.viewer)).expect(403);
  });

  it('rejects invalid input', async () => {
    await create(tokens.owner, { startDate: '2020-01-01' })
      .expect(400)
      .expect((r) => {
        expect(r.body.code).toBe('start_date_in_past');
      });
    await create(tokens.owner, { endDate: '2034-12-31' }).expect(400);
    await create(tokens.owner, { frequency: 'daily' }).expect(400);
    await create(tokens.owner, { surprise: true }).expect(400);
    await create(tokens.owner, { lineItems: [] }).expect(400);
    // 2 x the per-line maximum overflows the money rules
    await create(tokens.owner, {
      lineItems: [
        {
          description: 'x',
          quantity: '2',
          unitPriceCents: 10_000_000_000_000,
          taxRateBps: 0,
        },
      ],
    }).expect(400);
  });

  it('keeps tenants apart', async () => {
    const tpl = (await create(tokens.owner).expect(201)).body;
    // a non-member sees the same 404 as for a missing org
    await http()
      .get(`${base()}/${tpl.id}`)
      .set(auth(tokens.outsider))
      .expect(404);
    // another org's client id is indistinguishable from an unknown one
    await http()
      .post(base())
      .set(auth(tokens.owner))
      .send(body({ clientId: otherClientId }))
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('unknown_client'));
    // and the other org cannot see this template through its own URL
    await http()
      .get(`/v1/orgs/${otherOrgId}/recurring-invoices/${tpl.id}`)
      .set(auth(tokens.outsider))
      .expect(404);
  });

  it('updates the mutable fields and replaces line items', async () => {
    const tpl = (await create(tokens.owner).expect(201)).body;
    const res = await http()
      .patch(`${base()}/${tpl.id}`)
      .set(auth(tokens.owner))
      .send({
        name: 'Retainer v2',
        dueInDays: 30,
        autoSend: true,
        lineItems: [
          {
            description: 'Design',
            quantity: '2.5',
            unitPriceCents: 4000,
            taxRateBps: 825,
          },
          {
            description: 'Hosting',
            quantity: '1',
            unitPriceCents: 900,
            taxRateBps: 0,
          },
        ],
      })
      .expect(200);
    expect(res.body).toMatchObject({
      name: 'Retainer v2',
      dueInDays: 30,
      autoSend: true,
    });
    expect(
      res.body.lineItems.map((l: { description: string }) => l.description),
    ).toEqual(['Design', 'Hosting']);
    expect(res.body.lineItems[0].quantity).toBe('2.5');
  });

  it('refuses to change the schedule identity', async () => {
    const tpl = (await create(tokens.owner).expect(201)).body;
    for (const field of [
      { frequency: 'weekly' },
      { startDate: '2036-01-01' },
      { clientId },
    ]) {
      await http()
        .patch(`${base()}/${tpl.id}`)
        .set(auth(tokens.owner))
        .send(field)
        .expect(400);
    }
    await http()
      .patch(`${base()}/${tpl.id}`)
      .set(auth(tokens.owner))
      .send({})
      .expect(400);
    await http()
      .patch(`${base()}/${tpl.id}`)
      .set(auth(tokens.owner))
      .send({ endDate: '2035-01-30' })
      .expect(400)
      .expect((r) => expect(r.body.code).toBe('end_before_start'));
  });

  it('skips missed runs when a paused template resumes', async () => {
    const tpl = (
      await create(tokens.owner, { startDate: '2035-01-31' }).expect(201)
    ).body;
    const paused = await http()
      .patch(`${base()}/${tpl.id}`)
      .set(auth(tokens.owner))
      .send({ active: false })
      .expect(200);
    expect(paused.body).toMatchObject({
      active: false,
      nextRunOn: '2035-01-31',
      runCount: 0,
    });

    // simulated "today" is mid-March: Jan and Feb runs are skipped, not generated
    const resumed = await service.update(
      ids.owner,
      orgId,
      tpl.id,
      { active: true },
      '2035-03-15',
    );
    expect(resumed).toMatchObject({
      active: true,
      runCount: 2,
      nextRunOn: '2035-03-31',
    });
  });

  it('soft-deletes and then hides the template', async () => {
    const tpl = (await create(tokens.owner).expect(201)).body;
    await http()
      .delete(`${base()}/${tpl.id}`)
      .set(auth(tokens.owner))
      .expect(204);
    await http().get(`${base()}/${tpl.id}`).set(auth(tokens.owner)).expect(404);
    await http()
      .delete(`${base()}/${tpl.id}`)
      .set(auth(tokens.owner))
      .expect(404);
    const list = await http().get(base()).set(auth(tokens.owner)).expect(200);
    expect(list.body.map((x: { id: string }) => x.id)).not.toContain(tpl.id);
  });

  it('keeps the runtime role blind to templates without a tenant', async () => {
    const rows = await appPool.query(
      'SELECT count(*)::int AS n FROM recurring_templates',
    );
    expect(rows.rows[0].n).toBe(0);
  });
});
