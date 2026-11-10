import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool, PoolClient } from 'pg';
import {
  createAdminPool,
  createAppPool,
  deleteOrganizations,
} from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

interface Tenant {
  orgId: string;
  clientId: string;
}

interface InvoiceRow {
  org: string;
  client: string;
  number?: string | null;
  status?: string;
  issue?: string;
  due?: string;
  sub?: number;
  tax?: number;
  total?: number;
}

describe('Invoice schema: RLS, foreign keys, constraints (database level)', () => {
  let t: TestApp;
  let admin: Pool;
  let app: Pool;
  const emails: string[] = [];
  const orgIds: string[] = [];
  let a: Tenant;
  let b: Tenant;
  let c: Tenant; // constraint tests
  let d: Tenant; // second org, for "number reusable across organizations"
  let invoiceA: string;
  let invoiceB: string;
  let lineA: string;
  let lineB: string;
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  // Runs fn as the application role, inside a transaction with tenant context.
  async function asTenant<T>(
    orgId: string | null,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await app.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.user_id', $1, true)", [
        randomUUID(),
      ]);
      if (orgId) {
        await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      }
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  const insertInvoice = (client: PoolClient, o: InvoiceRow) =>
    client.query(
      `INSERT INTO invoices (id, org_id, client_id, number, status, issue_date,
         due_date, subtotal_cents, tax_cents, total_cents, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
      [
        o.org,
        o.client,
        o.number ?? null,
        o.status ?? 'draft',
        o.issue ?? '2026-01-01',
        o.due ?? '2026-01-31',
        o.sub ?? 0,
        o.tax ?? 0,
        o.total ?? (o.sub ?? 0) + (o.tax ?? 0),
      ],
    );

  const insertLine = (
    client: PoolClient,
    o: {
      org: string;
      invoice: string;
      position?: number;
      description?: string;
      quantity?: number;
      bps?: number;
    },
  ) =>
    client.query(
      `INSERT INTO invoice_line_items (id, org_id, invoice_id, position,
         description, quantity, unit_price_cents, tax_rate_bps,
         line_total_cents, line_tax_cents)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, 1000, $6, 1000, 0)`,
      [
        o.org,
        o.invoice,
        o.position ?? 1,
        o.description ?? 'Work',
        o.quantity ?? 1,
        o.bps ?? 0,
      ],
    );

  const rejects = (promise: Promise<unknown>, code: string) =>
    expect(promise).rejects.toMatchObject({ code });

  async function createOrg(token: string, name: string): Promise<string> {
    const res = await http()
      .post('/v1/orgs')
      .set(auth(token))
      .send({ name })
      .expect(201);
    return res.body.id;
  }

  async function createTenant(token: string, name: string): Promise<Tenant> {
    const orgId = await createOrg(token, name);
    orgIds.push(orgId);
    const client = await http()
      .post(`/v1/orgs/${orgId}/clients`)
      .set(auth(token))
      .send({ name: `${name} client` })
      .expect(201);
    return { orgId, clientId: client.body.id };
  }

  async function adminInvoice(tenant: Tenant): Promise<string> {
    const inv = await admin.query(
      `INSERT INTO invoices (id, org_id, client_id, issue_date, due_date, updated_at)
       VALUES (gen_random_uuid(), $1, $2, '2026-01-01', '2026-01-31', now())
       RETURNING id`,
      [tenant.orgId, tenant.clientId],
    );
    return inv.rows[0].id;
  }

  async function adminLine(tenant: Tenant, invoiceId: string): Promise<string> {
    const line = await admin.query(
      `INSERT INTO invoice_line_items (id, org_id, invoice_id, position,
         description, quantity, unit_price_cents, tax_rate_bps,
         line_total_cents, line_tax_cents)
       VALUES (gen_random_uuid(), $1, $2, 1, 'Work', 1, 1000, 0, 1000, 0)
       RETURNING id`,
      [tenant.orgId, invoiceId],
    );
    return line.rows[0].id;
  }

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
    app = createAppPool();

    const alice = await registerAndLogin(t);
    const bob = await registerAndLogin(t);
    emails.push(alice.email, bob.email);

    a = await createTenant(alice.accessToken, 'Alpha');
    b = await createTenant(bob.accessToken, 'Bravo');
    c = await createTenant(alice.accessToken, 'Charlie');
    d = await createTenant(alice.accessToken, 'Delta');

    invoiceA = await adminInvoice(a);
    invoiceB = await adminInvoice(b);
    lineA = await adminLine(a, invoiceA);
    lineB = await adminLine(b, invoiceB);
    await admin.query(
      'INSERT INTO invoice_counters (org_id) VALUES ($1), ($2)',
      [a.orgId, b.orgId],
    );
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await admin.end();
    await app.end();
    await t.app.close();
  });

  describe('row-level security', () => {
    it('shows each tenant only its own rows in all three tables', async () => {
      await asTenant(a.orgId, async (client) => {
        const inv = await client.query('SELECT id FROM invoices');
        const lines = await client.query('SELECT id FROM invoice_line_items');
        const counters = await client.query('SELECT org_id FROM invoice_counters');
        expect(inv.rows.map((r) => r.id)).toEqual([invoiceA]);
        expect(lines.rows.map((r) => r.id)).toEqual([lineA]);
        expect(counters.rows.map((r) => r.org_id)).toEqual([a.orgId]);
      });
      await asTenant(b.orgId, async (client) => {
        const inv = await client.query('SELECT id FROM invoices');
        const lines = await client.query('SELECT id FROM invoice_line_items');
        expect(inv.rows.map((r) => r.id)).toEqual([invoiceB]);
        expect(lines.rows.map((r) => r.id)).toEqual([lineB]);
      });
    });

    it('returns nothing without a tenant context', async () => {
      await asTenant(null, async (client) => {
        for (const table of ['invoices', 'invoice_line_items', 'invoice_counters']) {
          const res = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
          expect(res.rows[0].n).toBe(0);
        }
      });
    });

    it("cannot insert a row into another tenant's organization", async () => {
      await rejects(
        asTenant(a.orgId, (client) =>
          insertInvoice(client, { org: b.orgId, client: b.clientId }),
        ),
        '42501',
      );
    });

    it('cannot move an invoice to another tenant', async () => {
      await rejects(
        asTenant(a.orgId, (client) =>
          client.query('UPDATE invoices SET org_id = $1 WHERE id = $2', [
            b.orgId,
            invoiceA,
          ]),
        ),
        '42501',
      );
    });

    it("cannot see, update or delete another tenant's rows", async () => {
      await asTenant(a.orgId, async (client) => {
        const upd = await client.query(
          "UPDATE invoices SET due_date = '2027-01-01' WHERE id = $1",
          [invoiceB],
        );
        const del = await client.query(
          'DELETE FROM invoice_line_items WHERE id = $1',
          [lineB],
        );
        expect(upd.rowCount).toBe(0);
        expect(del.rowCount).toBe(0);
      });
      const still = await admin.query('SELECT due_date::text FROM invoices WHERE id = $1', [invoiceB]);
      expect(still.rows[0].due_date).toBe('2026-01-31');
    });
  });

  describe('composite foreign keys keep references inside one tenant', () => {
    it("rejects an invoice that points at another tenant's client", async () => {
      // org_id = A passes the RLS check; only the composite key can stop this.
      await rejects(
        asTenant(a.orgId, (client) =>
          insertInvoice(client, { org: a.orgId, client: b.clientId }),
        ),
        '23503',
      );
    });

    it("rejects a line item that points at another tenant's invoice", async () => {
      await rejects(
        asTenant(a.orgId, (client) =>
          insertLine(client, { org: a.orgId, invoice: invoiceB, position: 2 }),
        ),
        '23503',
      );
    });
  });

  describe('privileges', () => {
    it('does not let the application role hard-delete invoices or counters', async () => {
      await rejects(
        asTenant(a.orgId, (client) =>
          client.query('DELETE FROM invoices WHERE id = $1', [invoiceA]),
        ),
        '42501',
      );
      await rejects(
        asTenant(a.orgId, (client) =>
          client.query('DELETE FROM invoice_counters WHERE org_id = $1', [a.orgId]),
        ),
        '42501',
      );
    });
  });

  describe('check constraints', () => {
    it('requires total = subtotal + tax and non-negative amounts', async () => {
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, sub: 1000, tax: 100, total: 1000 }),
        ),
        '23514',
      );
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, sub: -1, tax: 0, total: -1 }),
        ),
        '23514',
      );
    });

    it('rejects a due date before the issue date and a bad currency', async () => {
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, issue: '2026-02-01', due: '2026-01-01' }),
        ),
        '23514',
      );
      await rejects(
        asTenant(c.orgId, (client) =>
          client.query(
            `INSERT INTO invoices (id, org_id, client_id, currency, issue_date, due_date, updated_at)
             VALUES (gen_random_uuid(), $1, $2, 'usd', '2026-01-01', '2026-01-31', now())`,
            [c.orgId, c.clientId],
          ),
        ),
        '23514',
      );
    });

    it('requires a number once an invoice is sent, but not for drafts or voided drafts', async () => {
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'sent' }),
        ),
        '23514',
      );
      await asTenant(c.orgId, async (client) => {
        await insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'draft' });
        await insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'draft' });
        await insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'void' });
      });
    });

    it('enforces the number format', async () => {
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'sent', number: 'INV-12' }),
        ),
        '23514',
      );
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'sent', number: 'abc' }),
        ),
        '23514',
      );
    });

    it('makes numbers unique per organization but reusable across organizations', async () => {
      await asTenant(c.orgId, (client) =>
        insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'sent', number: 'INV-000001' }),
      );
      await rejects(
        asTenant(c.orgId, (client) =>
          insertInvoice(client, { org: c.orgId, client: c.clientId, status: 'sent', number: 'INV-000001' }),
        ),
        '23505',
      );
      await asTenant(d.orgId, (client) =>
        insertInvoice(client, { org: d.orgId, client: d.clientId, status: 'sent', number: 'INV-000001' }),
      );
    });

    it('validates line items', async () => {
      const inv = await adminInvoice(c);
      const bad = (o: Partial<Parameters<typeof insertLine>[1]>) =>
        rejects(
          asTenant(c.orgId, (client) =>
            insertLine(client, { org: c.orgId, invoice: inv, position: 5, ...o }),
          ),
          '23514',
        );
      await bad({ quantity: 0 });
      await bad({ bps: 10_001 });
      await bad({ bps: -1 });
      await bad({ description: '' });
      await bad({ position: 0 });
    });

    it('keeps line positions unique within an invoice', async () => {
      const inv = await adminInvoice(c);
      await asTenant(c.orgId, (client) =>
        insertLine(client, { org: c.orgId, invoice: inv, position: 1 }),
      );
      await rejects(
        asTenant(c.orgId, (client) =>
          insertLine(client, { org: c.orgId, invoice: inv, position: 1 }),
        ),
        '23505',
      );
    });
  });

  describe('cascade', () => {
    it('deletes an organization with clients, invoices, lines and a counter', async () => {
      const alice = await registerAndLogin(t);
      emails.push(alice.email);
      const e = await createTenant(alice.accessToken, 'Echo');
      const inv = await adminInvoice(e);
      await adminLine(e, inv);
      await admin.query('INSERT INTO invoice_counters (org_id) VALUES ($1)', [e.orgId]);

      await deleteOrganizations(admin, [e.orgId]);

      for (const [table, column] of [
        ['organizations', 'id'],
        ['clients', 'org_id'],
        ['invoices', 'org_id'],
        ['invoice_line_items', 'org_id'],
        ['invoice_counters', 'org_id'],
      ]) {
        const res = await admin.query(
          `SELECT count(*)::int AS n FROM ${table} WHERE ${column} = $1`,
          [e.orgId],
        );
        expect(res.rows[0].n).toBe(0);
      }
    });
  });
});
