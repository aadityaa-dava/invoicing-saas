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

interface InvoiceBody {
  id: string;
  number: string | null;
  status: string;
  currency: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  lineItems: {
    position: number;
    description: string;
    quantity: string;
    unitPriceCents: number;
    taxRateBps: number;
    lineTotalCents: number;
    lineTaxCents: number;
  }[];
}

describe('Draft invoices (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let orgId: string;
  let clientId: string;
  let bobOrgId: string;
  let bobClientId: string;
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

  async function createOrgWithClient(token: string, name: string) {
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
    return { orgId: org.body.id as string, clientId: client.body.id as string };
  }

  const body = (cid: string, over: Record<string, unknown> = {}) => ({
    clientId: cid,
    issueDate: '2026-03-01',
    dueDate: '2026-03-31',
    lineItems: [
      {
        description: 'Consulting',
        quantity: '2',
        unitPriceCents: 1000,
        taxRateBps: 825,
      },
      { description: 'Hosting', quantity: '0.5', unitPriceCents: 1001 },
    ],
    ...over,
  });

  const post = (token: string, org: string, payload: unknown) =>
    http()
      .post(`/v1/orgs/${org}/invoices`)
      .set(auth(token))
      .send(payload as object);

  async function newInvoice(over: Record<string, unknown> = {}) {
    const res = await post(tokens.owner, orgId, body(clientId, over)).expect(201);
    return res.body as InvoiceBody;
  }

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();

    const owner = await createUser();
    tokens.owner = owner.token;
    ({ orgId, clientId } = await createOrgWithClient(owner.token, 'Billing Co'));
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const u = await createUser();
      tokens[role] = u.token;
      await addMember(admin, orgId, u.id, role);
    }

    const bob = await createUser();
    tokens.bob = bob.token;
    ({ orgId: bobOrgId, clientId: bobClientId } = await createOrgWithClient(
      bob.token,
      'Bob Co',
    ));
  });

  beforeEach(() => isolateRateLimits(t));

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await admin.end();
    await t.app.close();
  });

  describe('create', () => {
    it('creates a draft and computes every amount on the server', async () => {
      const inv = await newInvoice();
      expect(inv).toMatchObject({
        status: 'draft',
        number: null,
        currency: 'USD',
        subtotalCents: 2501, // 2000 + 501 (500.5 rounds half up)
        taxCents: 165, // 8.25% of 2000
        totalCents: 2666,
      });
      expect(inv.lineItems).toHaveLength(2);
      expect(inv.lineItems[0]).toMatchObject({
        position: 1,
        quantity: '2',
        lineTotalCents: 2000,
        lineTaxCents: 165,
      });
      expect(inv.lineItems[1]).toMatchObject({
        position: 2,
        quantity: '0.5',
        taxRateBps: 0,
        lineTotalCents: 501,
        lineTaxCents: 0,
      });
    });

    it('rounds tax per line, so the printed numbers add up', async () => {
      const line = {
        description: 'Widget',
        quantity: '1',
        unitPriceCents: 333,
        taxRateBps: 825,
      };
      const inv = await newInvoice({ lineItems: [line, line, line] });
      // each line tax: 27.47 -> 27. Taxing the 999 total once would give 82.
      expect(inv.subtotalCents).toBe(999);
      expect(inv.taxCents).toBe(81);
      expect(inv.totalCents).toBe(1080);
    });

    it('never accepts client-supplied totals or ids', async () => {
      for (const extra of [
        { totalCents: 1 },
        { subtotalCents: 1 },
        { status: 'paid' },
        { number: 'INV-000001' },
        { orgId: bobOrgId },
      ]) {
        await post(tokens.owner, orgId, body(clientId, extra)).expect(400);
      }
    });

    it('rejects invalid input', async () => {
      const item = { description: 'x', quantity: '1', unitPriceCents: 100 };
      const cases: Record<string, unknown>[] = [
        { lineItems: [] },
        { lineItems: [{ ...item, quantity: 1.5 }] }, // number, not a string
        { lineItems: [{ ...item, quantity: '0' }] },
        { lineItems: [{ ...item, quantity: '1.23456' }] },
        { lineItems: [{ ...item, unitPriceCents: -1 }] },
        { lineItems: [{ ...item, unitPriceCents: 10.5 }] },
        { lineItems: [{ ...item, taxRateBps: 10_001 }] },
        { lineItems: [{ ...item, description: '' }] },
        { lineItems: Array.from({ length: 201 }, () => item) },
        { currency: 'JPY' },
        { issueDate: '2026-02-30' },
        { issueDate: '03/01/2026' },
        { issueDate: '2026-04-01', dueDate: '2026-03-01' },
        { clientId: 'not-a-uuid' },
      ];
      for (const over of cases) {
        await post(tokens.owner, orgId, body(clientId, over)).expect(400);
      }
    });

    it('rejects an amount above the cap with a clear code', async () => {
      const res = await post(
        tokens.owner,
        orgId,
        body(clientId, {
          lineItems: [
            { description: 'Huge', quantity: '2', unitPriceCents: 10 ** 13 },
          ],
        }),
      ).expect(400);
      expect(res.body.code).toBe('amount_too_large');
    });

    it("treats another tenant's client exactly like an unknown one", async () => {
      const foreign = await post(
        tokens.owner,
        orgId,
        body(bobClientId),
      ).expect(400);
      const unknown = await post(
        tokens.owner,
        orgId,
        body('00000000-0000-4000-8000-000000000000'),
      ).expect(400);
      expect(foreign.body.code).toBe('unknown_client');
      expect(unknown.body.code).toBe('unknown_client');
    });
  });

  describe('read', () => {
    it('gets one invoice with lines, and lists summaries without them', async () => {
      const inv = await newInvoice();
      const one = await http()
        .get(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.viewer))
        .expect(200);
      expect(one.body).toEqual(JSON.parse(JSON.stringify(inv)));

      const list = await http()
        .get(`/v1/orgs/${orgId}/invoices`)
        .set(auth(tokens.viewer))
        .expect(200);
      const found = list.body.find((i: { id: string }) => i.id === inv.id);
      expect(found).toMatchObject({ id: inv.id, totalCents: 2666 });
      expect(found).not.toHaveProperty('lineItems');
    });

    it('404s for an unknown invoice, 400s for a bad id or bad filter', async () => {
      const res = await http()
        .get(`/v1/orgs/${orgId}/invoices/00000000-0000-4000-8000-000000000000`)
        .set(auth(tokens.owner))
        .expect(404);
      expect(res.body.code).toBe('invoice_not_found');
      await http()
        .get(`/v1/orgs/${orgId}/invoices/not-a-uuid`)
        .set(auth(tokens.owner))
        .expect(400);
      await http()
        .get(`/v1/orgs/${orgId}/invoices?status=bogus`)
        .set(auth(tokens.owner))
        .expect(400);
    });
  });

  describe('update', () => {
    it('replaces the lines and recomputes the totals', async () => {
      const inv = await newInvoice();
      const res = await http()
        .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.member))
        .send({
          lineItems: [
            {
              description: 'Flat fee',
              quantity: '1',
              unitPriceCents: 5000,
              taxRateBps: 1000,
            },
          ],
        })
        .expect(200);
      expect(res.body).toMatchObject({
        subtotalCents: 5000,
        taxCents: 500,
        totalCents: 5500,
      });
      expect(res.body.lineItems).toHaveLength(1);

      const { rows } = await admin.query(
        'SELECT count(*)::int AS n FROM invoice_line_items WHERE invoice_id = $1',
        [inv.id],
      );
      expect(rows[0].n).toBe(1); // the old lines are gone, not orphaned
    });

    it('changes dates alone without touching lines or amounts', async () => {
      const inv = await newInvoice();
      const res = await http()
        .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .send({ dueDate: '2026-05-01' })
        .expect(200);
      expect(res.body.dueDate).toBe('2026-05-01');
      expect(res.body.totalCents).toBe(2666);
      expect(res.body.lineItems).toHaveLength(2);
    });

    it('rejects an empty update and a due date before the issue date', async () => {
      const inv = await newInvoice();
      const patch = (payload: object) =>
        http()
          .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
          .set(auth(tokens.owner))
          .send(payload);
      await patch({}).expect(400);
      await patch({ total: 1 }).expect(400);
      const res = await patch({ dueDate: '2026-02-01' }).expect(400);
      expect(res.body.code).toBe('due_before_issue');
    });

    it('freezes an invoice once it has left draft', async () => {
      const inv = await newInvoice();
      await admin.query(
        "UPDATE invoices SET status = 'sent', number = 'INV-000001', sent_at = now() WHERE id = $1",
        [inv.id],
      );
      const patch = await http()
        .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .send({ dueDate: '2026-06-01' })
        .expect(409);
      expect(patch.body.code).toBe('invoice_not_draft');
      await http()
        .delete(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .expect(409);

      const sent = await http()
        .get(`/v1/orgs/${orgId}/invoices?status=sent`)
        .set(auth(tokens.owner))
        .expect(200);
      expect(sent.body.map((i: { id: string }) => i.id)).toContain(inv.id);
      const drafts = await http()
        .get(`/v1/orgs/${orgId}/invoices?status=draft`)
        .set(auth(tokens.owner))
        .expect(200);
      expect(drafts.body.map((i: { id: string }) => i.id)).not.toContain(inv.id);
    });

    it('makes an edit wait for a send in progress, then refuses it', async () => {
      const inv = await newInvoice();
      const holder = await admin.connect();
      let res: request.Response;
      try {
        // Simulates a send: holds the invoice row locked.
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM invoices WHERE id = $1 FOR UPDATE', [
          inv.id,
        ]);

        let settled = false;
        const pending = http()
          .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
          .set(auth(tokens.owner))
          .send({ dueDate: '2026-04-15' })
          .then((r) => {
            settled = true;
            return r;
          });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false); // blocked on the row lock

        await holder.query(
          "UPDATE invoices SET status = 'sent', number = 'INV-000002', sent_at = now() WHERE id = $1",
          [inv.id],
        );
        await holder.query('COMMIT');
        res = await pending;
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('invoice_not_draft');
      const { rows } = await admin.query(
        'SELECT due_date::text AS due_date FROM invoices WHERE id = $1',
        [inv.id],
      );
      expect(rows[0].due_date).toBe('2026-03-31'); // the edit changed nothing
    });
  });

  describe('delete (soft)', () => {
    it('soft-deletes a draft: hidden everywhere, row kept', async () => {
      const inv = await newInvoice();
      await http()
        .delete(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.member))
        .expect(204);

      await http()
        .get(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .expect(404);
      await http()
        .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .send({ dueDate: '2026-07-01' })
        .expect(404);
      const list = await http()
        .get(`/v1/orgs/${orgId}/invoices`)
        .set(auth(tokens.owner))
        .expect(200);
      expect(list.body.map((i: { id: string }) => i.id)).not.toContain(inv.id);
      await http()
        .delete(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .expect(404);

      const { rows } = await admin.query(
        'SELECT deleted_at FROM invoices WHERE id = $1',
        [inv.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].deleted_at).not.toBeNull();
    });
  });

  describe('permissions and tenancy', () => {
    it('lets a viewer read but not write', async () => {
      const inv = await newInvoice();
      const viewer = tokens.viewer;
      await http().get(`/v1/orgs/${orgId}/invoices`).set(auth(viewer)).expect(200);
      await post(viewer, orgId, body(clientId)).expect(403);
      await http()
        .patch(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(viewer))
        .send({ dueDate: '2026-08-01' })
        .expect(403);
      await http()
        .delete(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(viewer))
        .expect(403);
    });

    it('lets members and admins create drafts', async () => {
      for (const role of ['member', 'admin'] as const) {
        await post(tokens[role], orgId, body(clientId)).expect(201);
      }
    });

    it("cannot read, change or delete another tenant's invoice by id", async () => {
      const inv = await newInvoice();
      const own = `/v1/orgs/${bobOrgId}/invoices/${inv.id}`;
      // Bob uses his OWN org path with Alice's invoice id: RLS hides it.
      await http().get(own).set(auth(tokens.bob)).expect(404);
      await http()
        .patch(own)
        .set(auth(tokens.bob))
        .send({ dueDate: '2026-09-01' })
        .expect(404);
      await http().delete(own).set(auth(tokens.bob)).expect(404);
      // Bob using Alice's org path is stopped at the membership guard.
      await http()
        .get(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.bob))
        .expect(404);
      await post(tokens.bob, orgId, body(bobClientId)).expect(404);

      const still = await http()
        .get(`/v1/orgs/${orgId}/invoices/${inv.id}`)
        .set(auth(tokens.owner))
        .expect(200);
      expect(still.body.status).toBe('draft');
    });
  });
});
