import type { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import request from 'supertest';
import { MAIL_JOB_NAME } from '../src/mail/mail.types';
import { EMAIL_QUEUE } from '../src/queue/queue.constants';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

const mailpit = () => `http://localhost:${process.env.MAIL_UI_PORT ?? '8025'}`;

async function waitFor<T>(
  probe: () => Promise<T | undefined> | T | undefined,
  timeoutMs = 10_000,
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

interface MailpitMessage {
  ID: string;
  Subject: string;
  Text: string;
  Attachments: { FileName: string; ContentType: string; PartID: string }[];
}

describe('Invoice email delivery (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let queue: Queue;
  let token: string;
  let orgId: string;
  const orgName = 'Mail Co';
  const userEmails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = () => ({ Authorization: `Bearer ${token}` });

  async function createClient(email?: string): Promise<string> {
    const res = await http()
      .post(`/v1/orgs/${orgId}/clients`)
      .set(auth())
      .send({ name: 'Globex', ...(email ? { email } : {}) })
      .expect(201);
    return res.body.id;
  }

  async function sendInvoiceFor(clientId: string) {
    const draft = await http()
      .post(`/v1/orgs/${orgId}/invoices`)
      .set(auth())
      .send({
        clientId,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lineItems: [
          {
            description: 'Work',
            quantity: '1',
            unitPriceCents: 1000,
            taxRateBps: 825,
          },
        ],
      })
      .expect(201);
    const sent = await http()
      .post(`/v1/orgs/${orgId}/invoices/${draft.body.id}/send`)
      .set(auth())
      .expect(200);
    return sent.body as { id: string; number: string };
  }

  async function inbox(to: string) {
    const res = await fetch(
      `${mailpit()}/api/v1/search?query=${encodeURIComponent(`to:${to}`)}`,
    );
    return ((await res.json()) as { messages: { ID: string }[] }).messages;
  }

  beforeAll(async () => {
    t = await createTestApp({ workers: true });
    admin = createAdminPool();
    queue = t.app.get<Queue>(EMAIL_QUEUE);
    const user = await registerAndLogin(t);
    userEmails.push(user.email);
    token = user.accessToken;
    const org = await http()
      .post('/v1/orgs')
      .set(auth())
      .send({ name: orgName })
      .expect(201);
    orgId = org.body.id;
    orgIds.push(orgId);
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await admin.query('DELETE FROM users WHERE email = ANY($1::text[])', [
      userEmails,
    ]);
    await admin.end();
    await queue.obliterate({ force: true });
    await t.app.close();
  });

  it('emails the client a real PDF when the invoice is sent', async () => {
    const to = `billing-${randomUUID()}@client.test`;
    const invoice = await sendInvoiceFor(await createClient(to));

    const [found] = await waitFor(async () => {
      const messages = await inbox(to);
      return messages.length > 0 ? messages : undefined;
    });
    const message = (await (
      await fetch(`${mailpit()}/api/v1/message/${found.ID}`)
    ).json()) as MailpitMessage;

    expect(message.Subject).toBe(`Invoice ${invoice.number} from ${orgName}`);
    expect(message.Text).toContain(invoice.number);
    expect(message.Attachments).toHaveLength(1);
    const [attachment] = message.Attachments;
    expect(attachment.FileName).toBe(`${invoice.number}.pdf`);
    expect(attachment.ContentType).toBe('application/pdf');

    const bytes = Buffer.from(
      await (
        await fetch(
          `${mailpit()}/api/v1/message/${found.ID}/part/${attachment.PartID}`,
        )
      ).arrayBuffer(),
    );
    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  }, 20_000);

  it('queues nothing when the client has no email address', async () => {
    const invoice = await sendInvoiceFor(await createClient());
    expect(t.mail.invoiceEmails.map((e) => e.invoiceId)).not.toContain(
      invoice.id,
    );
    expect(await queue.getJob(`invoice-sent-${invoice.id}`)).toBeUndefined();
  }, 20_000);

  it('skips a voided invoice without failing or re-sending', async () => {
    const to = `billing-${randomUUID()}@client.test`;
    const invoice = await sendInvoiceFor(await createClient(to));
    await waitFor(async () =>
      (await inbox(to)).length === 1 ? true : undefined,
    );

    await http()
      .post(`/v1/orgs/${orgId}/invoices/${invoice.id}/void`)
      .set(auth())
      .expect(200);

    const jobId = `redelivery-${randomUUID()}`;
    await queue.add(
      MAIL_JOB_NAME,
      { kind: 'invoice-sent', orgId, invoiceId: invoice.id },
      { jobId },
    );
    // Completed jobs are removed, failed ones are kept: a job that vanishes
    // without ever failing was processed and deliberately skipped.
    await waitFor(async () => ((await queue.getJob(jobId)) ? undefined : true));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await inbox(to)).toHaveLength(1);
  }, 20_000);
});
