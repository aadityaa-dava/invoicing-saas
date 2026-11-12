import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

describe('Invoice payment links (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  const orgIds: string[] = [];
  const userEmails: string[] = [];
  const http = () => request(t.app.getHttpServer());

  let tokenA: string;
  let orgA: string;
  let tokenB: string;
  let orgB: string;
  const authA = () => ({ Authorization: `Bearer ${tokenA}` });
  const authB = () => ({ Authorization: `Bearer ${tokenB}` });

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

  async function makeInvoice(options: {
    unitPriceCents?: number;
    send?: boolean;
    clientEmail?: string;
  }) {
    const client = await http()
      .post(`/v1/orgs/${orgA}/clients`)
      .set(authA())
      .send({
        name: 'Globex',
        ...(options.clientEmail ? { email: options.clientEmail } : {}),
      })
      .expect(201);
    const draft = await http()
      .post(`/v1/orgs/${orgA}/invoices`)
      .set(authA())
      .send({
        clientId: client.body.id,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lineItems: [
          {
            description: 'Work',
            quantity: '1',
            unitPriceCents: options.unitPriceCents ?? 5000,
            taxRateBps: 0,
          },
        ],
      })
      .expect(201);
    if (options.send === false) return draft.body as Invoice;
    const sent = await http()
      .post(`/v1/orgs/${orgA}/invoices/${draft.body.id}/send`)
      .set(authA())
      .expect(200);
    return sent.body as Invoice;
  }

  type Invoice = { id: string; number: string; totalCents: number };

  // There is no endpoint yet that sets these states, so they are set through
  // the owner connection, inside a transaction scoped to the tenant because
  // row-level security is forced even for the owner.
  async function forceState(invoiceId: string, sql: string) {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgA]);
      await client.query(sql, [invoiceId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  const link = (invoiceId: string, org = orgA, auth = authA) =>
    http()
      .post(`/v1/orgs/${org}/invoices/${invoiceId}/payment-link`)
      .set(auth());

  const checkoutsFor = (invoiceId: string) =>
    t.stripe.invoiceCheckouts.filter((c) => c.invoiceId === invoiceId);

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
    ({ token: tokenA, orgId: orgA } = await newOrg('Pay Co'));
    ({ token: tokenB, orgId: orgB } = await newOrg('Other Co'));
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await t.app.close();
  });

  it('creates a checkout from database values only', async () => {
    const email = `pay-${randomUUID()}@client.test`;
    const invoice = await makeInvoice({
      unitPriceCents: 12345,
      clientEmail: email,
    });

    const res = await link(invoice.id).expect(201);
    expect(res.body.url).toMatch(
      /^https:\/\/checkout\.stripe\.test\/pay\/cs_test_/,
    );

    const [checkout] = checkoutsFor(invoice.id);
    expect(checkout.amountCents).toBe(invoice.totalCents);
    expect(checkout.amountCents).toBe(12345);
    expect(checkout.currency).toBe('USD');
    expect(checkout.orgId).toBe(orgA);
    expect(checkout.invoiceNumber).toBe(invoice.number);
    expect(checkout.customerEmail).toBe(email);
    expect(checkout.successUrl).toContain('/payments/success');
    expect(checkout.cancelUrl).toContain('/payments/cancelled');
  });

  it('refuses a draft invoice', async () => {
    const draft = await makeInvoice({ send: false });
    const res = await link(draft.id).expect(409);
    expect(res.body.code).toBe('invoice_not_payable');
    expect(checkoutsFor(draft.id)).toHaveLength(0);
  });

  it('refuses a voided invoice', async () => {
    const invoice = await makeInvoice({});
    await http()
      .post(`/v1/orgs/${orgA}/invoices/${invoice.id}/void`)
      .set(authA())
      .expect(200);
    const res = await link(invoice.id).expect(409);
    expect(res.body.code).toBe('invoice_not_payable');
  });

  it('refuses an invoice that is already paid', async () => {
    const invoice = await makeInvoice({});
    await forceState(
      invoice.id,
      "UPDATE invoices SET status = 'paid', paid_at = now() WHERE id = $1::uuid",
    );
    const res = await link(invoice.id).expect(409);
    expect(res.body.code).toBe('invoice_not_payable');
    expect(checkoutsFor(invoice.id)).toHaveLength(0);
  });

  it('lets an overdue invoice be paid', async () => {
    const invoice = await makeInvoice({});
    await forceState(
      invoice.id,
      "UPDATE invoices SET status = 'overdue' WHERE id = $1::uuid",
    );
    await link(invoice.id).expect(201);
    expect(checkoutsFor(invoice.id)).toHaveLength(1);
  });

  it('refuses an amount below the minimum Stripe accepts', async () => {
    const invoice = await makeInvoice({ unitPriceCents: 40 });
    const res = await link(invoice.id).expect(422);
    expect(res.body.code).toBe('amount_too_small_for_online_payment');
    expect(checkoutsFor(invoice.id)).toHaveLength(0);
  });

  it('keeps one open session per invoice by expiring the previous one', async () => {
    const invoice = await makeInvoice({});
    const first = await link(invoice.id).expect(201);
    const second = await link(invoice.id).expect(201);

    expect(second.body.url).not.toBe(first.body.url);
    const sessions = checkoutsFor(invoice.id);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].expired).toBe(true);
    expect(sessions[1].expired).toBe(false);
  });

  it('creates a single session when two requests overlap', async () => {
    const invoice = await makeInvoice({});
    // Hold the gateway open so both requests read the invoice before either
    // stores a session. They then share one idempotency key.
    let release!: () => void;
    t.stripe.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.stripe.entered = 0;
    try {
      const pending = Promise.all([link(invoice.id), link(invoice.id)]);
      const deadline = Date.now() + 5000;
      while (t.stripe.entered < 2) {
        if (Date.now() > deadline) throw new Error('requests did not overlap');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      release();
      const [a, b] = await pending;

      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(a.body.url).toBe(b.body.url);
      expect(checkoutsFor(invoice.id)).toHaveLength(1);
      expect(checkoutsFor(invoice.id)[0].expired).toBe(false);
    } finally {
      release();
      t.stripe.gate = undefined;
    }
  });

  it('still succeeds when expiring the previous session fails', async () => {
    const invoice = await makeInvoice({});
    await link(invoice.id).expect(201);
    t.stripe.failExpire = true;
    try {
      await link(invoice.id).expect(201);
    } finally {
      t.stripe.failExpire = false;
    }
    expect(checkoutsFor(invoice.id)).toHaveLength(2);
  });

  it('answers 404 for an unknown invoice and 400 for a malformed id', async () => {
    const res = await link(randomUUID()).expect(404);
    expect(res.body.code).toBe('invoice_not_found');
    await link('not-a-uuid').expect(400);
  });

  it('hides the organization from a non-member and the invoice from another tenant', async () => {
    const invoice = await makeInvoice({});
    // Not a member of organization A.
    await link(invoice.id, orgA, authB).expect(404);
    // A member of B asking for A's invoice through B's own path.
    const res = await link(invoice.id, orgB, authB).expect(404);
    expect(res.body.code).toBe('invoice_not_found');
    expect(checkoutsFor(invoice.id)).toHaveLength(0);
  });

  it('expires the open checkout session when the invoice is voided', async () => {
    const invoice = await makeInvoice({});
    await link(invoice.id).expect(201);
    await http()
      .post(`/v1/orgs/${orgA}/invoices/${invoice.id}/void`)
      .set(authA())
      .expect(200);

    expect(checkoutsFor(invoice.id)[0].expired).toBe(true);
    const res = await link(invoice.id).expect(409);
    expect(res.body.code).toBe('invoice_not_payable');
  });

  it('still voids the invoice when the session cannot be expired', async () => {
    const invoice = await makeInvoice({});
    await link(invoice.id).expect(201);
    t.stripe.failExpire = true;
    try {
      await http()
        .post(`/v1/orgs/${orgA}/invoices/${invoice.id}/void`)
        .set(authA())
        .expect(200);
    } finally {
      t.stripe.failExpire = false;
    }
    const res = await http()
      .get(`/v1/orgs/${orgA}/invoices/${invoice.id}`)
      .set(authA())
      .expect(200);
    expect(res.body.status).toBe('void');
  });

  it('requires authentication', async () => {
    await http()
      .post(`/v1/orgs/${orgA}/invoices/${randomUUID()}/payment-link`)
      .expect(401);
  });
});
