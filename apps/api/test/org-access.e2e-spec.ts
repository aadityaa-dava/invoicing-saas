import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

describe('Organization access guard (e2e)', () => {
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

  async function createOrg(token: string, name: string): Promise<string> {
    const res = await http()
      .post('/v1/orgs')
      .set(auth(token))
      .send({ name })
      .expect(201);
    orgIds.push(res.body.id);
    return res.body.id;
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
    await http().get(`/v1/orgs/${randomUUID()}`).expect(401);
  });

  it('lets a member read their organization, with their role', async () => {
    const alice = await newUser();
    const orgId = await createOrg(alice.accessToken, 'Alice Co');
    const res = await http()
      .get(`/v1/orgs/${orgId}`)
      .set(auth(alice.accessToken))
      .expect(200);
    expect(res.body).toMatchObject({
      id: orgId,
      name: 'Alice Co',
      role: 'owner',
    });
  });

  it('returns 404 to a non-member, identical to a nonexistent org', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const aliceOrg = await createOrg(alice.accessToken, 'Alice Co');

    const forbidden = await http()
      .get(`/v1/orgs/${aliceOrg}`)
      .set(auth(bob.accessToken));
    const missing = await http()
      .get(`/v1/orgs/${randomUUID()}`)
      .set(auth(bob.accessToken));

    expect(forbidden.status).toBe(404);
    expect(missing.status).toBe(404);
    // Same status and same code: nothing reveals that the org exists.
    expect(forbidden.body.code).toBe('not_found');
    expect(forbidden.body.code).toBe(missing.body.code);
    expect(forbidden.body.title).toBe(missing.body.title);
  });

  it('returns 404 (not 500) for a malformed organization id', async () => {
    const alice = await newUser();
    await http()
      .get('/v1/orgs/not-a-uuid')
      .set(auth(alice.accessToken))
      .expect(404);
  });

  it('reports the real role for a lower-privileged member', async () => {
    const alice = await newUser();
    const bob = await newUser();
    const orgId = await createOrg(alice.accessToken, 'Shared Co');

    const me = await http().get('/v1/me').set(auth(bob.accessToken));
    await admin.query(
      `INSERT INTO memberships (id, org_id, user_id, role)
       VALUES (gen_random_uuid(), $1, $2, 'member')`,
      [orgId, me.body.id],
    );

    const res = await http()
      .get(`/v1/orgs/${orgId}`)
      .set(auth(bob.accessToken))
      .expect(200);
    expect(res.body.role).toBe('member');
  });
});
