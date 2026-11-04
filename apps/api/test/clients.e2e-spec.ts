import request from 'supertest';
import type { Pool } from 'pg';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

describe('Clients and members (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  const emails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newTenant(orgName: string) {
    const user = await registerAndLogin(t);
    emails.push(user.email);
    const res = await http()
      .post('/v1/orgs')
      .set(auth(user.accessToken))
      .send({ name: orgName })
      .expect(201);
    orgIds.push(res.body.id);
    return { ...user, orgId: res.body.id as string };
  }

  async function createClient(
    tenant: { accessToken: string; orgId: string },
    body: Record<string, unknown>,
  ) {
    const res = await http()
      .post(`/v1/orgs/${tenant.orgId}/clients`)
      .set(auth(tenant.accessToken))
      .send(body)
      .expect(201);
    return res.body as { id: string; name: string };
  }

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();
  });

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await admin.end();
    await t.app.close();
  });

  it('creates and lists clients inside your organization', async () => {
    const alice = await newTenant('Alice Co');
    const created = await createClient(alice, {
      name: 'Globex',
      email: 'Billing@Globex.test',
      taxId: 'GB123',
    });
    expect(created).toMatchObject({
      name: 'Globex',
      email: 'billing@globex.test',
      taxId: 'GB123',
    });

    const list = await http()
      .get(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(alice.accessToken))
      .expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([created.id]);
  });

  it("tenant B cannot list, create in, or see tenant A's clients", async () => {
    const alice = await newTenant('Alice Co');
    const bob = await newTenant('Bob Co');
    const aliceClient = await createClient(alice, { name: 'Alice Customer' });
    const bobClient = await createClient(bob, { name: 'Bob Customer' });

    // Bob using Alice's org id: 404, for both read and write.
    await http()
      .get(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(bob.accessToken))
      .expect(404);
    await http()
      .post(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(bob.accessToken))
      .send({ name: 'Injected' })
      .expect(404);

    // Bob using his own org id: only his data, with no app-side filter.
    const bobList = await http()
      .get(`/v1/orgs/${bob.orgId}/clients`)
      .set(auth(bob.accessToken))
      .expect(200);
    const ids = bobList.body.map((c: { id: string }) => c.id);
    expect(ids).toEqual([bobClient.id]);
    expect(ids).not.toContain(aliceClient.id);

    // And Alice's data is untouched.
    const aliceList = await http()
      .get(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(alice.accessToken))
      .expect(200);
    expect(aliceList.body.map((c: { id: string }) => c.id)).toEqual([
      aliceClient.id,
    ]);
  });

  it('rejects unknown fields, including an attempt to set orgId', async () => {
    const alice = await newTenant('Alice Co');
    const bob = await newTenant('Bob Co');
    await http()
      .post(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(alice.accessToken))
      .send({ name: 'Sneaky', orgId: bob.orgId })
      .expect(400);
    await http()
      .post(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(alice.accessToken))
      .send({ name: '' })
      .expect(400);
    await http()
      .post(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(alice.accessToken))
      .send({ name: 'Bad email', email: 'nope' })
      .expect(400);
  });

  it('hides soft-deleted clients', async () => {
    const alice = await newTenant('Alice Co');
    const keep = await createClient(alice, { name: 'Keep' });
    const gone = await createClient(alice, { name: 'Gone' });
    await admin.query('UPDATE clients SET deleted_at = now() WHERE id = $1', [
      gone.id,
    ]);
    const list = await http()
      .get(`/v1/orgs/${alice.orgId}/clients`)
      .set(auth(alice.accessToken))
      .expect(200);
    expect(list.body.map((c: { id: string }) => c.id)).toEqual([keep.id]);
  });

  it('lists members of your organization only', async () => {
    const alice = await newTenant('Alice Co');
    const bob = await newTenant('Bob Co');
    const res = await http()
      .get(`/v1/orgs/${alice.orgId}/members`)
      .set(auth(alice.accessToken))
      .expect(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ email: alice.email, role: 'owner' });
    expect(JSON.stringify(res.body)).not.toContain(bob.email);

    await http()
      .get(`/v1/orgs/${alice.orgId}/members`)
      .set(auth(bob.accessToken))
      .expect(404);
  });
});
