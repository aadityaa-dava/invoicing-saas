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

interface Org {
  orgId: string;
  clientId: string;
}

// Collects a binary response body into a Buffer.
const binary = (
  res: NodeJS.ReadableStream,
  callback: (error: Error | null, body: Buffer) => void,
) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const pagesOf = (pdf: Buffer) =>
  (pdf.toString('latin1').match(/\/Type \/Page(?!s)/g) ?? []).length;

describe('Invoice PDF (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let main: Org;
  let bob: Org;
  const emails: string[] = [];
  const orgIds: string[] = [];
  const tokens = {} as Record<'owner' | 'viewer' | 'bob', string>;
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
      .send({
        name: `${name} client`,
        email: 'billing@example.test',
        billingAddress: '1 Main Street\nSpringfield',
        taxId: 'TX-1',
      })
      .expect(201);
    return { orgId: org.body.id, clientId: client.body.id };
  }

  async function draft(
    org: Org,
    lineItems: object[] = [
      { description: 'Work', quantity: '1', unitPriceCents: 1000, taxRateBps: 825 },
    ],
  ): Promise<{ id: string }> {
    const res = await http()
      .post(`/v1/orgs/${org.orgId}/invoices`)
      .set(auth(tokens.owner))
      .send({
        clientId: org.clientId,
        issueDate: '2026-03-01',
        dueDate: '2026-03-31',
        lineItems,
      })
      .expect(201);
    return res.body;
  }

  const pdf = (org: Org, id: string, token = tokens.owner) =>
    http()
      .get(`/v1/orgs/${org.orgId}/invoices/${id}/pdf`)
      .set(auth(token))
      .buffer(true)
      .parse(binary);

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
    const owner = await createUser();
    tokens.owner = owner.token;
    main = await createOrg(owner.token, 'Print Co');
    const viewer = await createUser();
    tokens.viewer = viewer.token;
    await addMember(admin, main.orgId, viewer.id, 'viewer');
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

  it('serves a draft as a private PDF named after the draft, not a number', async () => {
    const inv = await draft(main);
    const res = await pdf(main, inv.id).expect(200);
    expect(res.headers['content-type']).toContain('application/pdf');
    expect(res.headers['content-disposition']).toMatch(
      /^inline; filename="draft-[0-9a-f]{8}\.pdf"$/,
    );
    expect(res.headers['cache-control']).toContain('no-store');
    const body = res.body as Buffer;
    expect(body.subarray(0, 5).toString()).toBe('%PDF-');
    expect(body.subarray(-16).toString()).toContain('%%EOF');
  });

  it('names a sent invoice after its number', async () => {
    const org = await createOrg(tokens.owner, 'Numbered Co');
    const inv = await draft(org);
    await http()
      .post(`/v1/orgs/${org.orgId}/invoices/${inv.id}/send`)
      .set(auth(tokens.owner))
      .expect(200);
    const res = await pdf(org, inv.id).expect(200);
    expect(res.headers['content-disposition']).toBe(
      'inline; filename="INV-000001.pdf"',
    );
  });

  it('keeps the number on a voided invoice', async () => {
    const org = await createOrg(tokens.owner, 'Voided Co');
    const inv = await draft(org);
    await http()
      .post(`/v1/orgs/${org.orgId}/invoices/${inv.id}/send`)
      .set(auth(tokens.owner))
      .expect(200);
    await http()
      .post(`/v1/orgs/${org.orgId}/invoices/${inv.id}/void`)
      .set(auth(tokens.owner))
      .expect(200);
    const res = await pdf(org, inv.id).expect(200);
    expect(res.headers['content-disposition']).toContain('INV-000001.pdf');
  });

  it('lets a viewer download it, and refuses anonymous requests', async () => {
    const inv = await draft(main);
    await pdf(main, inv.id, tokens.viewer).expect(200);
    await http().get(`/v1/orgs/${main.orgId}/invoices/${inv.id}/pdf`).expect(401);
  });

  it("does not expose another tenant's invoice", async () => {
    const inv = await draft(main);
    await pdf(bob, inv.id, tokens.bob).expect(404); // Bob's own org path
    await pdf(main, inv.id, tokens.bob).expect(404); // Alice's org path
  });

  it('404s for deleted and unknown invoices, 400s for a bad id', async () => {
    const inv = await draft(main);
    await http()
      .delete(`/v1/orgs/${main.orgId}/invoices/${inv.id}`)
      .set(auth(tokens.owner))
      .expect(204);
    await pdf(main, inv.id).expect(404);
    await pdf(main, '00000000-0000-4000-8000-000000000000').expect(404);
    await http()
      .get(`/v1/orgs/${main.orgId}/invoices/not-a-uuid/pdf`)
      .set(auth(tokens.owner))
      .expect(400);
  });

  it('flows a long invoice onto several pages', async () => {
    const items = Array.from({ length: 60 }, (_, i) => ({
      description: `Line item number ${i + 1}`,
      quantity: '1',
      unitPriceCents: 1000 + i,
      taxRateBps: 825,
    }));
    const inv = await draft(main, items);
    const res = await pdf(main, inv.id).expect(200);
    expect(pagesOf(res.body as Buffer)).toBeGreaterThan(1);
  });

  it('renders accented, non-Latin and markup-like text without failing', async () => {
    const inv = await draft(main, [
      {
        description: 'Café — naïve 日本語 ☕ <script>alert(1)</script> & "quotes"',
        quantity: '1',
        unitPriceCents: 500,
      },
    ]);
    const res = await pdf(main, inv.id).expect(200);
    expect((res.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
  });

  it('still prints an invoice whose client was deleted afterwards', async () => {
    const org = await createOrg(tokens.owner, 'Archive Co');
    const inv = await draft(org);
    await http()
      .delete(`/v1/orgs/${org.orgId}/clients/${org.clientId}`)
      .set(auth(tokens.owner))
      .expect(204);
    await pdf(org, inv.id).expect(200);
  });
});
