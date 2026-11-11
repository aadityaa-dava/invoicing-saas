import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import {
  JOBS_QUEUE,
  OVERDUE_SWEEP,
  RECURRING_SWEEP,
  SCHEDULES,
  type JobData,
} from '../src/jobs/jobs.constants';
import { JobsProcessor } from '../src/jobs/jobs.processor';
import { EMAIL_QUEUE } from '../src/queue/queue.constants';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error('timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

// The sweeps are global by design, so these tests use dates no other suite
// uses: overdue as of 2026-02-16 (others are due 2026-03-31 or later) and
// recurring as of 2030-01-20 (others start in 2035).
describe('Scheduled jobs (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let jobs: Queue<JobData>;
  let token: string;
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function newOrg() {
    const org = await http()
      .post('/v1/orgs')
      .set(auth())
      .send({ name: `Jobs ${randomUUID()}` })
      .expect(201);
    orgIds.push(org.body.id);
    const client = await http()
      .post(`/v1/orgs/${org.body.id}/clients`)
      .set(auth())
      .send({ name: 'Client' })
      .expect(201);
    return { orgId: org.body.id as string, clientId: client.body.id as string };
  }

  const lines = [
    { description: 'Work', quantity: '1', unitPriceCents: 1000, taxRateBps: 0 },
  ];

  async function sentInvoice(
    o: { orgId: string; clientId: string },
    dueDate: string,
  ) {
    const draft = await http()
      .post(`/v1/orgs/${o.orgId}/invoices`)
      .set(auth())
      .send({
        clientId: o.clientId,
        issueDate: '2026-02-01',
        dueDate,
        lineItems: lines,
      })
      .expect(201);
    await http()
      .post(`/v1/orgs/${o.orgId}/invoices/${draft.body.id}/send`)
      .set(auth())
      .expect(200);
    return draft.body.id as string;
  }

  const statusOf = async (id: string) =>
    (await admin.query('SELECT status FROM invoices WHERE id = $1', [id]))
      .rows[0].status as string;

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    admin = createAdminPool();
    jobs = t.app.get<Queue<JobData>>(JOBS_QUEUE, { strict: false });
    const user = await registerAndLogin(t);
    userEmails.push(user.email);
    token = user.accessToken;
  });

  afterAll(async () => {
    await jobs.obliterate({ force: true });
    await t.app
      .get<Queue>(EMAIL_QUEUE, { strict: false })
      .obliterate({ force: true });
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await t.app.close();
  });

  it('runs the overdue sweep through the queue, org by org', async () => {
    const o = await newOrg();
    const due = await sentInvoice(o, '2026-02-15');
    const notDue = await sentInvoice(o, '2026-06-30');

    await jobs.add(OVERDUE_SWEEP, { asOf: '2026-02-16' });

    await waitFor(async () =>
      (await statusOf(due)) === 'overdue' ? true : undefined,
    );
    expect(await statusOf(notDue)).toBe('sent');
  }, 30_000);

  it('runs recurring generation through the queue and stays idempotent', async () => {
    const o = await newOrg();
    const tpl = await http()
      .post(`/v1/orgs/${o.orgId}/recurring-invoices`)
      .set(auth())
      .send({
        clientId: o.clientId,
        name: 'Retainer',
        frequency: 'monthly',
        startDate: '2030-01-15',
        lineItems: lines,
      })
      .expect(201);
    const count = async () =>
      (
        await admin.query(
          'SELECT count(*)::int AS n FROM invoices WHERE recurring_template_id = $1',
          [tpl.body.id],
        )
      ).rows[0].n as number;

    await jobs.add(RECURRING_SWEEP, { asOf: '2030-01-20' });
    await waitFor(async () => ((await count()) === 1 ? true : undefined));

    // a second sweep for the same day must not create another invoice
    await jobs.add(RECURRING_SWEEP, { asOf: '2030-01-20' });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(await count()).toBe(1);

    const next = await admin.query(
      'SELECT next_run_on::text AS next FROM recurring_templates WHERE id = $1',
      [tpl.body.id],
    );
    expect(next.rows[0].next).toBe('2030-02-15');
  }, 30_000);

  it('registers the daily schedules once, even when registered again', async () => {
    const ours = (keys: string[]) =>
      keys.filter((key) => SCHEDULES.some((s) => s.id === key));
    const before = ours((await jobs.getJobSchedulers()).map((s) => s.key));
    expect(before.sort()).toEqual(SCHEDULES.map((s) => s.id).sort());

    await t.app.get(JobsProcessor, { strict: false }).registerSchedules();
    const after = ours((await jobs.getJobSchedulers()).map((s) => s.key));
    expect(after).toHaveLength(SCHEDULES.length);
  });
});
