import request from 'supertest';
import type { Pool } from 'pg';
import {
  addMember,
  createAdminPool,
  deleteOrganizations,
} from './support/admin-db';
import {
  createTestApp,
  isolateRateLimits,
  registerAndLogin,
  TestApp,
} from './support/test-app';

type Role = 'owner' | 'admin' | 'member' | 'viewer';
interface Org {
  orgId: string;
  clientId: string;
}
interface Inv {
  id: string;
  number: string | null;
  status: string;
  sentAt: string | null;
  voidedAt: string | null;
  totalCents: number;
}

describe('Send, void and numbering (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let main: Org; // org with all four roles
  let bob: Org;
  const emails: string[] = [];
  const orgIds: string[] = [];
  const tokens = {} as Record<Role | 'bob', string>;
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createUser() {
    const u = await registerAndLogin(t);
    emails.push(u.email);
    const me = await http().get('/v1/me').set(auth(u.accessToken));
    return { token: u.accessToken, id: me.body.id as string };
  }

  async function createOrg(token: string, name: string): Promise<Org> {
    const org = await http()
      .post('/v1/orgs')
      .set(auth(token))
      .send({ name })
      .expect(201);
    orgIds.push(org.body.id);
    const client = await http()
      .post(`/v1/orgs/${org.body.id}/clients`)
      .set(auth(token))
      .send({ name: `${name} client` })
      .expect(201);
    return { orgId: org.body.id, clientId: client.body.id };
  }

  async function draft(org: Org, token = tokens.owner): Promise<Inv> {
    const res = await http()
      .post(`/v1/orgs/${org.orgId}/invoices`)
      .set(auth(token))
      .send({
        clientId: org.clientId,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lineItems: [
          { description: 'Work', quantity: '1', unitPriceCents: 1000, taxRateBps: 825 },
        ],
      })
      .expect(201);
    return res.body;
  }

  const send = (org: Org, id: string, token = tokens.owner) =>
    http().post(`/v1/orgs/${org.orgId}/invoices/${id}/send`).set(auth(token));
  const voidIt = (org: Org, id: string, token = tokens.owner) =>
    http().post(`/v1/orgs/${org.orgId}/invoices/${id}/void`).set(auth(token));
  const getInv = async (org: Org, id: string): Promise<Inv> =>
    (await http().get(`/v1/orgs/${org.orgId}/invoices/${id}`).set(auth(tokens.owner)).expect(200)).body;

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();

    const owner = await createUser();
    tokens.owner = owner.token;
    main = await createOrg(owner.token, 'Send Co');
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const u = await createUser();
      tokens[role] = u.token;
      await addMember(admin, main.orgId, u.id, role);
    }
    const b = await createUser();
    tokens.bob = b.token;
    bob = await createOrg(b.token, 'Bob Co');
  });

  beforeEach(() => isolateRateLimits(t));

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await admin.end();
    await t.app.close();
  });

  describe('numbering', () => {
    it('assigns numbers at send time, in send order, starting at INV-000001', async () => {
      const org = await createOrg(tokens.owner, 'Numbering Co');
      const first = await draft(org);
      const second = await draft(org);

      // Send the SECOND draft first: the number follows the send, not creation.
      const a = await send(org, second.id).expect(200);
      expect(a.body).toMatchObject({ status: 'sent', number: 'INV-000001' });
      expect(a.body.sentAt).not.toBeNull();
      expect(a.body.totalCents).toBe(second.totalCents); // amounts untouched

      const b = await send(org, first.id).expect(200);
      expect(b.body.number).toBe('INV-000002');
    });

    it('leaves no gaps for abandoned drafts', async () => {
      const org = await createOrg(tokens.owner, 'Gapless Co');
      const keep1 = await draft(org);
      const abandoned = await draft(org);
      const keep2 = await draft(org);
      await http()
        .delete(`/v1/orgs/${org.orgId}/invoices/${abandoned.id}`)
        .set(auth(tokens.owner))
        .expect(204);

      expect((await send(org, keep1.id).expect(200)).body.number).toBe('INV-000001');
      expect((await send(org, keep2.id).expect(200)).body.number).toBe('INV-000002');
    });

    it('numbers each organization independently', async () => {
      const orgA = await createOrg(tokens.owner, 'Indep A');
      const orgB = await createOrg(tokens.bob, 'Indep B');
      const a = await draft(orgA);
      const b = await draft(orgB, tokens.bob);
      expect((await send(orgA, a.id).expect(200)).body.number).toBe('INV-000001');
      expect((await send(orgB, b.id, tokens.bob).expect(200)).body.number).toBe('INV-000001');
    });

    it('does not resend or renumber a sent invoice', async () => {
      const org = await createOrg(tokens.owner, 'Resend Co');
      const inv = await draft(org);
      await send(org, inv.id).expect(200);
      const again = await send(org, inv.id).expect(409);
      expect(again.body.code).toBe('invoice_not_draft');
      expect((await getInv(org, inv.id)).number).toBe('INV-000001');
      // The refused send did not consume a number.
      const next = await draft(org);
      expect((await send(org, next.id).expect(200)).body.number).toBe('INV-000002');
    });

    it('gives unique, gapless numbers when many sends race', async () => {
      const org = await createOrg(tokens.owner, 'Race Co');
      const drafts: Inv[] = [];
      for (let i = 0; i < 8; i++) drafts.push(await draft(org));

      // Includes the very first send of the organization (no counter yet).
      const results = await Promise.all(drafts.map((d) => send(org, d.id)));

      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200));
      const numbers = results.map((r) => r.body.number as string).sort();
      expect(numbers).toEqual(
        Array.from({ length: 8 }, (_, i) => `INV-${String(i + 1).padStart(6, '0')}`),
      );
    });

    it('rolls the counter back when a send fails after taking a number', async () => {
      const org = await createOrg(tokens.owner, 'Rollback Co');
      const first = await draft(org);
      const failing = await draft(org);
      const blocker = await draft(org);
      await send(org, first.id).expect(200); // takes INV-000001, counter -> 2

      // Make the NEXT number (INV-000002) already taken, so the invoice update
      // fails after the counter has been incremented inside the transaction.
      await admin.query(
        "UPDATE invoices SET status = 'sent', number = 'INV-000002', sent_at = now() WHERE id = $1",
        [blocker.id],
      );
      const failed = await send(org, failing.id);
      expect(failed.status).toBe(500);

      const counter = await admin.query(
        'SELECT next_number FROM invoice_counters WHERE org_id = $1',
        [org.orgId],
      );
      expect(counter.rows[0].next_number).toBe(2); // increment rolled back
      expect((await getInv(org, failing.id)).status).toBe('draft');

      // Once the clash is resolved, numbering continues without a gap.
      await admin.query(
        'UPDATE invoice_counters SET next_number = 3 WHERE org_id = $1',
        [org.orgId],
      );
      expect((await send(org, failing.id).expect(200)).body.number).toBe('INV-000003');
    });
  });

  describe('void', () => {
    it('voids a sent invoice and keeps its number', async () => {
      const org = await createOrg(tokens.owner, 'Void Sent Co');
      const inv = await draft(org);
      await send(org, inv.id).expect(200);
      const res = await voidIt(org, inv.id).expect(200);
      expect(res.body).toMatchObject({ status: 'void', number: 'INV-000001' });
      expect(res.body.voidedAt).not.toBeNull();
      const again = await voidIt(org, inv.id).expect(409);
      expect(again.body.code).toBe('invoice_not_voidable');
    });

    it('voids a draft (no number) and then refuses to send it', async () => {
      const org = await createOrg(tokens.owner, 'Void Draft Co');
      const inv = await draft(org);
      const res = await voidIt(org, inv.id).expect(200);
      expect(res.body).toMatchObject({ status: 'void', number: null });
      const sent = await send(org, inv.id).expect(409);
      expect(sent.body.code).toBe('invoice_not_draft');
    });

    it('refuses to void a paid invoice', async () => {
      const org = await createOrg(tokens.owner, 'Paid Co');
      const inv = await draft(org);
      await admin.query(
        "UPDATE invoices SET status = 'paid', number = 'INV-000050', paid_at = now() WHERE id = $1",
        [inv.id],
      );
      const res = await voidIt(org, inv.id).expect(409);
      expect(res.body.code).toBe('invoice_not_voidable');
    });
  });

  describe('permissions and tenancy', () => {
    it('lets members send but not void; lets admins void; viewers do neither', async () => {
      const inv1 = await draft(main);
      const inv2 = await draft(main);
      const inv3 = await draft(main);

      await send(main, inv1.id, tokens.viewer).expect(403);
      await voidIt(main, inv1.id, tokens.viewer).expect(403);
      await send(main, inv1.id, tokens.member).expect(200);
      await voidIt(main, inv2.id, tokens.member).expect(403);
      await voidIt(main, inv2.id, tokens.admin).expect(200);
      await send(main, inv3.id, tokens.admin).expect(200);
    });

    it("cannot send or void another tenant's invoice by id", async () => {
      const inv = await draft(main);
      for (const action of ['send', 'void']) {
        await http()
          .post(`/v1/orgs/${bob.orgId}/invoices/${inv.id}/${action}`)
          .set(auth(tokens.bob))
          .expect(404); // Bob's own org path: RLS hides the invoice
        await http()
          .post(`/v1/orgs/${main.orgId}/invoices/${inv.id}/${action}`)
          .set(auth(tokens.bob))
          .expect(404); // Alice's org path: membership guard
      }
      expect((await getInv(main, inv.id)).status).toBe('draft');
    });
  });
});
