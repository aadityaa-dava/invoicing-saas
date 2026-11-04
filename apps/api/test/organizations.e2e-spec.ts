import request from 'supertest';
import type { Pool } from 'pg';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

describe('Organizations (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  const emails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newUser() {
    const u = await registerAndLogin(t);
    emails.push(u.email);
    return u;
  }

  async function createOrg(token: string, name: string) {
    const res = await http()
      .post('/v1/orgs')
      .set(auth(token))
      .send({ name })
      .expect(201);
    orgIds.push(res.body.id);
    return res.body as { id: string; name: string; slug: string; role: string };
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

  it('requires authentication', async () => {
    await http().post('/v1/orgs').send({ name: 'Acme' }).expect(401);
    await http().get('/v1/orgs').expect(401);
  });

  it('creates an organization and makes the creator its owner', async () => {
    const { accessToken } = await newUser();
    const org = await createOrg(accessToken, 'Acme Ltd');
    expect(org.name).toBe('Acme Ltd');
    expect(org.role).toBe('owner');
    expect(org.slug).toMatch(/^acme-ltd-[0-9a-f]{6}$/);

    const list = await http()
      .get('/v1/orgs')
      .set(auth(accessToken))
      .expect(200);
    expect(list.body).toEqual([
      { id: org.id, name: 'Acme Ltd', slug: org.slug, role: 'owner' },
    ]);
  });

  it('rejects invalid input, including a client-chosen id', async () => {
    const { accessToken } = await newUser();
    await http()
      .post('/v1/orgs')
      .set(auth(accessToken))
      .send({ name: '   ' })
      .expect(400);
    await http()
      .post('/v1/orgs')
      .set(auth(accessToken))
      .send({ name: 'Ok', id: '00000000-0000-4000-8000-000000000000' })
      .expect(400);
  });

  it('a new user with no organizations gets an empty list', async () => {
    const { accessToken } = await newUser();
    const res = await http()
      .get('/v1/orgs')
      .set(auth(accessToken))
      .expect(200);
    expect(res.body).toEqual([]);
  });

  it('two tenants never see each other through the API', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceOrg = await createOrg(alice.accessToken, 'Alice Co');
    const bobOrg = await createOrg(bob.accessToken, 'Bob Co');

    const aliceList = await http()
      .get('/v1/orgs')
      .set(auth(alice.accessToken))
      .expect(200);
    const bobList = await http()
      .get('/v1/orgs')
      .set(auth(bob.accessToken))
      .expect(200);

    expect(aliceList.body.map((o: { id: string }) => o.id)).toEqual([
      aliceOrg.id,
    ]);
    expect(bobList.body.map((o: { id: string }) => o.id)).toEqual([bobOrg.id]);
  });
});
