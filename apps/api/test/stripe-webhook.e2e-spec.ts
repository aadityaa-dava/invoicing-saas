import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

const PRO_PRICE = 'price_testpro0000000';

type WebhookEvent = Parameters<TestApp['stripe']['sign']>[0];

describe('Stripe webhooks (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  const orgIds: string[] = [];
  const userEmails: string[] = [];
  const eventIds: string[] = [];
  const http = () => request(t.app.getHttpServer());

  let tokenA: string;
  let orgA: string;
  let orgS: string;
  const authA = () => ({ Authorization: `Bearer ${tokenA}` });

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

  // Queries run inside a transaction scoped to a tenant, because row-level
  // security is forced even for the owner connection.
  async function inOrg<T extends object>(
    orgId: string,
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
      const res = await client.query(sql, params);
      await client.query('COMMIT');
      return res.rows as T[];
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  type Sent = { id: string; number: string; totalCents: number };

  async function payable(unitPriceCents = 5000) {
    const client = await http()
      .post(`/v1/orgs/${orgA}/clients`)
      .set(authA())
      .send({ name: 'Globex' })
      .expect(201);
    const draft = await http()
      .post(`/v1/orgs/${orgA}/invoices`)
      .set(authA())
      .send({
        clientId: client.body.id,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lineItems: [
          { description: 'Work', quantity: '1', unitPriceCents, taxRateBps: 0 },
        ],
      })
      .expect(201);
    const sent = (
      await http()
        .post(`/v1/orgs/${orgA}/invoices/${draft.body.id}/send`)
        .set(authA())
        .expect(200)
    ).body as Sent;
    await http()
      .post(`/v1/orgs/${orgA}/invoices/${sent.id}/payment-link`)
      .set(authA())
      .expect(201);
    const session = t.stripe.invoiceCheckouts.find(
      (c) => c.invoiceId === sent.id,
    )!;
    return { invoice: sent, session };
  }

  const newEventId = () => `evt_test_${randomUUID().replaceAll('-', '')}`;

  function paidEvent(
    inv: { invoice: Sent; session: { id: string } },
    over: Partial<{
      id: string;
      type: string;
      paymentIntent: string;
      amount: number;
      currency: string;
      paymentStatus: string;
      invoiceId: string;
    }> = {},
  ): WebhookEvent {
    return {
      id: over.id ?? newEventId(),
      type: over.type ?? 'checkout.session.completed',
      data: {
        object: {
          id: inv.session.id,
          mode: 'payment',
          payment_status: over.paymentStatus ?? 'paid',
          payment_intent:
            over.paymentIntent ?? `pi_test_${randomUUID().replaceAll('-', '')}`,
          amount_total: over.amount ?? inv.invoice.totalCents,
          currency: over.currency ?? 'usd',
          metadata: {
            orgId: orgA,
            invoiceId: over.invoiceId ?? inv.invoice.id,
          },
        },
      },
    };
  }

  function post(event: WebhookEvent) {
    eventIds.push(event.id);
    const { body, signature } = t.stripe.sign(event);
    return http()
      .post('/v1/webhooks/stripe')
      .set('Content-Type', 'application/json')
      .set('stripe-signature', signature)
      .send(body);
  }

  const payments = (invoiceId: string) =>
    inOrg<{
      status: string;
      amount_cents: string;
      stripe_payment_intent_id: string;
    }>(
      orgA,
      'SELECT status, amount_cents, stripe_payment_intent_id FROM payments WHERE invoice_id = $1::uuid ORDER BY created_at',
      [invoiceId],
    );
  const eventRow = async (id: string) =>
    (
      await admin.query(
        'SELECT type, outcome, org_id FROM webhook_events WHERE stripe_event_id = $1',
        [id],
      )
    ).rows[0] as
      { type: string; outcome: string; org_id: string | null } | undefined;
  const invoiceOf = async (id: string) =>
    (
      await http()
        .get(`/v1/orgs/${orgA}/invoices/${id}`)
        .set(authA())
        .expect(200)
    ).body as { status: string; paidAt: string | null };

  beforeAll(async () => {
    // Read when the application module is first loaded, so set it first.
    process.env.STRIPE_PRICE_PRO = PRO_PRICE;
    t = await createTestApp();
    admin = createAdminPool();
    ({ token: tokenA, orgId: orgA } = await newOrg('Webhook Co'));
    ({ orgId: orgS } = await newOrg('Subscriber Co'));
  });

  afterAll(async () => {
    await admin.query(
      'DELETE FROM webhook_events WHERE stripe_event_id = ANY($1::text[])',
      [eventIds],
    );
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await t.app.close();
  });

  describe('signature', () => {
    it('rejects a missing signature header', async () => {
      const res = await http()
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .send('{}')
        .expect(400);
      expect(res.body.code).toBe('invalid_signature');
    });

    it('rejects a wrong signature and does nothing', async () => {
      const inv = await payable();
      const event = paidEvent(inv);
      eventIds.push(event.id);
      const { body } = t.stripe.sign(event);
      const res = await http()
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 't=1700000000,v1=deadbeef')
        .send(body)
        .expect(400);
      expect(res.body.code).toBe('invalid_signature');
      expect((await invoiceOf(inv.invoice.id)).status).toBe('sent');
      expect(await eventRow(event.id)).toBeUndefined();
    });

    it('rejects a body that was changed after signing', async () => {
      const inv = await payable();
      const event = paidEvent(inv);
      eventIds.push(event.id);
      const { body, signature } = t.stripe.sign(event);
      await http()
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', signature)
        .send(body.replace('"paid"', '"pAid"'))
        .expect(400);
      expect((await invoiceOf(inv.invoice.id)).status).toBe('sent');
    });
  });

  describe('invoice payment', () => {
    it('marks the invoice paid, records the payment and the event', async () => {
      const inv = await payable(12345);
      const event = paidEvent(inv, { paymentIntent: 'pi_test_happy_0001' });
      await post(event).expect(200, { received: true });

      const invoice = await invoiceOf(inv.invoice.id);
      expect(invoice.status).toBe('paid');
      expect(invoice.paidAt).not.toBeNull();
      const rows = await payments(inv.invoice.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        status: 'succeeded',
        amount_cents: '12345',
        stripe_payment_intent_id: 'pi_test_happy_0001',
      });
      expect(await eventRow(event.id)).toMatchObject({
        type: 'checkout.session.completed',
        outcome: 'processed',
        org_id: orgA,
      });
    });

    it('verifies the exact bytes, not a re-serialized body', async () => {
      const inv = await payable();
      const event = paidEvent(inv);
      eventIds.push(event.id);
      // Pretty-printed with a different layout than JSON.stringify would give.
      const body = JSON.stringify(
        { object: 'event', created: 1_700_000_000, ...event },
        null,
        2,
      );
      await http()
        .post('/v1/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', t.stripe.signRaw(body))
        .send(body)
        .expect(200);
      expect((await invoiceOf(inv.invoice.id)).status).toBe('paid');
    });

    it('does nothing the second time the same event is delivered', async () => {
      const inv = await payable();
      const event = paidEvent(inv);
      await post(event).expect(200);
      const first = await invoiceOf(inv.invoice.id);
      await post(event).expect(200);

      expect(await payments(inv.invoice.id)).toHaveLength(1);
      expect((await invoiceOf(inv.invoice.id)).paidAt).toBe(first.paidAt);
    });

    it('handles two simultaneous deliveries of one event', async () => {
      const inv = await payable();
      const event = paidEvent(inv);
      const [a, b] = await Promise.all([post(event), post(event)]);

      expect(a.status).toBe(200);
      expect(b.status).toBe(200);
      expect(await payments(inv.invoice.id)).toHaveLength(1);
      const count = await admin.query(
        'SELECT count(*)::int AS n FROM webhook_events WHERE stripe_event_id = $1',
        [event.id],
      );
      expect(count.rows[0].n).toBe(1);
    });

    it('records one payment when the same payment arrives under another event', async () => {
      const inv = await payable();
      const intent = `pi_test_${randomUUID().replaceAll('-', '')}`;
      await post(paidEvent(inv, { paymentIntent: intent })).expect(200);
      await post(
        paidEvent(inv, {
          paymentIntent: intent,
          type: 'checkout.session.async_payment_succeeded',
        }),
      ).expect(200);
      expect(await payments(inv.invoice.id)).toHaveLength(1);
    });

    it('flags a second payment on an already paid invoice for refund', async () => {
      const inv = await payable();
      await post(paidEvent(inv)).expect(200);
      const paidAt = (await invoiceOf(inv.invoice.id)).paidAt;

      await post(paidEvent(inv)).expect(200);

      const rows = await payments(inv.invoice.id);
      expect(rows.map((r) => r.status)).toEqual(['succeeded', 'duplicate']);
      const after = await invoiceOf(inv.invoice.id);
      expect(after.status).toBe('paid');
      expect(after.paidAt).toBe(paidAt);
    });

    it('does not mark anything paid when the amount differs', async () => {
      const inv = await payable();
      const event = paidEvent(inv, { amount: inv.invoice.totalCents - 1 });
      await post(event).expect(200);
      expect((await invoiceOf(inv.invoice.id)).status).toBe('sent');
      expect(await payments(inv.invoice.id)).toHaveLength(0);
      expect((await eventRow(event.id))?.outcome).toBe('unmatched');
    });

    it('does not mark anything paid when the currency differs', async () => {
      const inv = await payable();
      const event = paidEvent(inv, { currency: 'eur' });
      await post(event).expect(200);
      expect((await invoiceOf(inv.invoice.id)).status).toBe('sent');
      expect((await eventRow(event.id))?.outcome).toBe('unmatched');
    });

    it('records an unknown invoice as unmatched and still answers 200', async () => {
      const inv = await payable();
      const event = paidEvent(inv, { invoiceId: randomUUID() });
      await post(event).expect(200);
      expect((await eventRow(event.id))?.outcome).toBe('unmatched');
      expect((await invoiceOf(inv.invoice.id)).status).toBe('sent');
    });

    it('waits for the async event when the session is not paid yet', async () => {
      const inv = await payable();
      const event = paidEvent(inv, { paymentStatus: 'unpaid' });
      await post(event).expect(200);
      expect((await invoiceOf(inv.invoice.id)).status).toBe('sent');
      expect((await eventRow(event.id))?.outcome).toBe('ignored');
    });

    it('records events it does not handle and acknowledges them', async () => {
      const event = {
        id: newEventId(),
        type: 'charge.refunded',
        data: { object: { id: 'ch_test_1' } },
      };
      await post(event).expect(200);
      expect(await eventRow(event.id)).toMatchObject({
        type: 'charge.refunded',
        outcome: 'ignored',
      });
    });
  });

  describe('subscription', () => {
    const customer = `cus_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const snapshot = (
      id: string,
      status: string,
      priceId: string | null = PRO_PRICE,
      customerId = customer,
    ) => ({
      id,
      customerId,
      status,
      priceId,
      currentPeriodEnd: new Date('2026-12-01T00:00:00Z'),
      cancelAtPeriodEnd: false,
    });
    const subEvent = (
      type: string,
      subscriptionId: string,
      orgId = orgS,
    ): WebhookEvent => ({
      id: newEventId(),
      type,
      data: { object: { id: subscriptionId, metadata: { orgId } } },
    });
    const row = async () =>
      (
        await inOrg<{
          plan: string;
          status: string;
          stripe_subscription_id: string;
        }>(
          orgS,
          'SELECT plan, status, stripe_subscription_id FROM subscriptions WHERE org_id = $1::uuid',
          [orgS],
        )
      )[0];

    beforeAll(async () => {
      await inOrg(
        orgS,
        'UPDATE organizations SET stripe_customer_id = $2 WHERE id = $1::uuid',
        [orgS, customer],
      );
    });

    it('stores the plan for the configured price', async () => {
      t.stripe.subscriptions.set('sub_a', snapshot('sub_a', 'active'));
      await post(subEvent('customer.subscription.created', 'sub_a')).expect(
        200,
      );
      expect(await row()).toMatchObject({
        plan: 'pro',
        status: 'active',
        stripe_subscription_id: 'sub_a',
      });
    });

    it('follows the current state from Stripe, not the event order', async () => {
      t.stripe.subscriptions.set('sub_a', snapshot('sub_a', 'canceled'));
      await post(subEvent('customer.subscription.deleted', 'sub_a')).expect(
        200,
      );
      expect(await row()).toMatchObject({ plan: 'pro', status: 'canceled' });
    });

    it('applies a new subscription after the old one ended', async () => {
      t.stripe.subscriptions.set('sub_b', snapshot('sub_b', 'active'));
      await post(subEvent('customer.subscription.created', 'sub_b')).expect(
        200,
      );
      expect(await row()).toMatchObject({
        status: 'active',
        stripe_subscription_id: 'sub_b',
      });
    });

    it('ignores a late event about the replaced subscription', async () => {
      t.stripe.subscriptions.set('sub_a', snapshot('sub_a', 'canceled'));
      const event = subEvent('customer.subscription.deleted', 'sub_a');
      await post(event).expect(200);
      expect(await row()).toMatchObject({
        status: 'active',
        stripe_subscription_id: 'sub_b',
      });
      expect((await eventRow(event.id))?.outcome).toBe('ignored');
    });

    it('maps an unknown price to the free plan', async () => {
      t.stripe.subscriptions.set(
        'sub_b',
        snapshot('sub_b', 'active', 'price_other0000000'),
      );
      await post(subEvent('customer.subscription.updated', 'sub_b')).expect(
        200,
      );
      expect((await row()).plan).toBe('free');
    });

    it("refuses a subscription whose customer is not the organization's", async () => {
      t.stripe.subscriptions.set(
        'sub_x',
        snapshot('sub_x', 'active', PRO_PRICE, 'cus_someone_else'),
      );
      const event = subEvent('customer.subscription.created', 'sub_x');
      await post(event).expect(200);
      expect((await row()).stripe_subscription_id).not.toBe('sub_x');
      expect((await eventRow(event.id))?.outcome).toBe('unmatched');
    });

    it('refuses an organization that has no Stripe customer', async () => {
      t.stripe.subscriptions.set('sub_y', snapshot('sub_y', 'active'));
      const event = subEvent('customer.subscription.created', 'sub_y', orgA);
      await post(event).expect(200);
      expect((await eventRow(event.id))?.outcome).toBe('unmatched');
    });

    it('creates a subscription from a completed subscription checkout', async () => {
      t.stripe.subscriptions.set('sub_c', snapshot('sub_c', 'active'));
      await post({
        id: newEventId(),
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_test_sub',
            mode: 'subscription',
            subscription: 'sub_c',
            metadata: { orgId: orgS },
          },
        },
      }).expect(200);
      expect((await row()).stripe_subscription_id).toBe('sub_c');
    });
  });
});
