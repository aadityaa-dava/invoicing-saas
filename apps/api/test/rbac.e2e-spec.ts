import request from 'supertest';
import type { Pool } from 'pg';
import {
  addMember,
  createAdminPool,
  deleteOrganizations,
} from './support/admin-db';
import { createTestApp, registerAndLogin, TestApp } from './support/test-app';

type Role = 'owner' | 'admin' | 'member' | 'viewer';

// Expected HTTP status per role, written out so it reads like the matrix.
const EXPECTED: Record<
  Role,
  { readClients: number; writeClient: number; members: number; org: number }
> = {
  owner: { readClients: 200, writeClient: 201, members: 200, org: 200 },
  admin: { readClients: 200, writeClient: 201, members: 200, org: 200 },
  member: { readClients: 200, writeClient: 201, members: 200, org: 200 },
  viewer: { readClients: 200, writeClient: 403, members: 200, org: 200 },
};

describe('RBAC (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let orgId: string;
  const emails: string[] = [];
  const tokens = {} as Record<Role, string>;
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();

    const owner = await registerAndLogin(t);
    emails.push(owner.email);
    tokens.owner = owner.accessToken;
    const org = await http()
      .post('/v1/orgs')
      .set(auth(owner.accessToken))
      .send({ name: 'Role Test Co' })
      .expect(201);
    orgId = org.body.id;

    for (const role of ['admin', 'member', 'viewer'] as const) {
      const u = await registerAndLogin(t);
      emails.push(u.email);
      tokens[role] = u.accessToken;
      const me = await http().get('/v1/me').set(auth(u.accessToken));
      await addMember(admin, orgId, me.body.id, role);
    }
  });

  afterAll(async () => {
    await deleteOrganizations(admin, [orgId]);
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await admin.end();
    await t.app.close();
  });

  const roles = Object.keys(EXPECTED) as Role[];

  it.each(roles)('%s: GET /orgs/:orgId', async (role) => {
    await http()
      .get(`/v1/orgs/${orgId}`)
      .set(auth(tokens[role]))
      .expect(EXPECTED[role].org);
  });

  it.each(roles)('%s: GET clients', async (role) => {
    await http()
      .get(`/v1/orgs/${orgId}/clients`)
      .set(auth(tokens[role]))
      .expect(EXPECTED[role].readClients);
  });

  it.each(roles)('%s: POST client', async (role) => {
    const res = await http()
      .post(`/v1/orgs/${orgId}/clients`)
      .set(auth(tokens[role]))
      .send({ name: `Created by ${role}` })
      .expect(EXPECTED[role].writeClient);
    if (EXPECTED[role].writeClient === 403) {
      expect(res.body.code).toBe('forbidden');
    }
  });

  it.each(roles)('%s: GET members', async (role) => {
    await http()
      .get(`/v1/orgs/${orgId}/members`)
      .set(auth(tokens[role]))
      .expect(EXPECTED[role].members);
  });

  it('a denied write really did not write anything', async () => {
    const res = await http()
      .get(`/v1/orgs/${orgId}/clients`)
      .set(auth(tokens.owner))
      .expect(200);
    const names = res.body.map((c: { name: string }) => c.name);
    expect(names).not.toContain('Created by viewer');
    expect(names).toEqual(
      expect.arrayContaining([
        'Created by owner',
        'Created by admin',
        'Created by member',
      ]),
    );
  });
});
