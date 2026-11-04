import { randomUUID } from 'node:crypto';
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

describe('Org rename and client CRUD (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  let orgId: string;
  let bobOrgId: string;
  const emails: string[] = [];
  const orgIds: string[] = [];
  const tokens = {} as Record<Role | 'bob', string>;
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function createUser(): Promise<{
    token: string;
    id: string;
  }> {
    const u = await registerAndLogin(t);
    emails.push(u.email);
    const me = await http().get('/v1/me').set(auth(u.accessToken));
    return { token: u.accessToken, id: me.body.id };
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

  async function createClient(
    token: string,
    org: string,
    body: Record<string, unknown>,
  ): Promise<{ id: string }> {
    const res = await http()
      .post(`/v1/orgs/${org}/clients`)
      .set(auth(token))
      .send(body)
      .expect(201);
    return res.body;
  }

  beforeAll(async () => {
    t = await createTestApp();
    admin = createAdminPool();

    const owner = await createUser();
    tokens.owner = owner.token;
    orgId = await createOrg(owner.token, 'Update Co');
    for (const role of ['admin', 'member', 'viewer'] as const) {
      const u = await createUser();
      tokens[role] = u.token;
      await addMember(admin, orgId, u.id, role);
    }

    const bob = await createUser();
    tokens.bob = bob.token;
    bobOrgId = await createOrg(bob.token, 'Bob Co');
  });

  beforeEach(() => isolateRateLimits(t));

  afterAll(async () => {
    await deleteOrganizations(admin, orgIds);
    await t.prisma.user.deleteMany({ where: { email: { in: emails } } });
    await admin.end();
    await t.app.close();
  });

  describe('PATCH /orgs/:orgId', () => {
    it('lets an owner and an admin rename; the slug stays stable', async () => {
      const before = await http()
        .get(`/v1/orgs/${orgId}`)
        .set(auth(tokens.owner))
        .expect(200);

      const r1 = await http()
        .patch(`/v1/orgs/${orgId}`)
        .set(auth(tokens.owner))
        .send({ name: 'Renamed By Owner' })
        .expect(200);
      expect(r1.body.name).toBe('Renamed By Owner');
      expect(r1.body.slug).toBe(before.body.slug);

      const r2 = await http()
        .patch(`/v1/orgs/${orgId}`)
        .set(auth(tokens.admin))
        .send({ name: 'Renamed By Admin' })
        .expect(200);
      expect(r2.body.name).toBe('Renamed By Admin');
    });

    it('forbids members and viewers', async () => {
      for (const role of ['member', 'viewer'] as const) {
        const res = await http()
          .patch(`/v1/orgs/${orgId}`)
          .set(auth(tokens[role]))
          .send({ name: 'Nope' })
          .expect(403);
        expect(res.body.code).toBe('forbidden');
      }
    });

    it('rejects bad input and hides the org from outsiders', async () => {
      const bad = (body: unknown) =>
        http()
          .patch(`/v1/orgs/${orgId}`)
          .set(auth(tokens.owner))
          .send(body as object);
      await bad({ name: '' }).expect(400);
      await bad({}).expect(400);
      await bad({ name: 'Ok', slug: 'hijack' }).expect(400);
      await http()
        .patch(`/v1/orgs/${orgId}`)
        .set(auth(tokens.bob))
        .send({ name: 'Hijacked' })
        .expect(404);
    });
  });

  describe('clients by id', () => {
    it('gets a client by id and 404s for an unknown one', async () => {
      const c = await createClient(tokens.member, orgId, { name: 'Initech' });
      const res = await http()
        .get(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.viewer))
        .expect(200);
      expect(res.body.name).toBe('Initech');

      const missing = await http()
        .get(`/v1/orgs/${orgId}/clients/${randomUUID()}`)
        .set(auth(tokens.viewer))
        .expect(404);
      expect(missing.body.code).toBe('client_not_found');

      await http()
        .get(`/v1/orgs/${orgId}/clients/not-a-uuid`)
        .set(auth(tokens.viewer))
        .expect(400);
    });

    it('updates part of a client and clears a field with null', async () => {
      const c = await createClient(tokens.member, orgId, {
        name: 'Umbrella',
        email: 'ops@umbrella.test',
        taxId: 'U-1',
      });
      const res = await http()
        .patch(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.member))
        .send({ name: 'Umbrella Corp', email: null })
        .expect(200);
      expect(res.body).toMatchObject({
        name: 'Umbrella Corp',
        email: null,
        taxId: 'U-1', // untouched
      });
    });

    it('rejects empty and unknown-field updates, and viewers', async () => {
      const c = await createClient(tokens.member, orgId, { name: 'Strict' });
      const patch = (token: string, body: object) =>
        http()
          .patch(`/v1/orgs/${orgId}/clients/${c.id}`)
          .set(auth(token))
          .send(body);
      await patch(tokens.member, {}).expect(400);
      await patch(tokens.member, { orgId: bobOrgId }).expect(400);
      await patch(tokens.member, { email: 'nope' }).expect(400);
      await patch(tokens.viewer, { name: 'X' }).expect(403);
    });

    it("cannot read, change or delete another tenant's client by id", async () => {
      const aliceClient = await createClient(tokens.owner, orgId, {
        name: 'Alice Private',
      });

      // Bob uses his OWN org path with Alice's client id: RLS hides the row.
      const viaOwnOrg = `/v1/orgs/${bobOrgId}/clients/${aliceClient.id}`;
      await http().get(viaOwnOrg).set(auth(tokens.bob)).expect(404);
      await http()
        .patch(viaOwnOrg)
        .set(auth(tokens.bob))
        .send({ name: 'Defaced' })
        .expect(404);
      await http().delete(viaOwnOrg).set(auth(tokens.bob)).expect(404);

      // Bob using Alice's org path is stopped earlier, at the membership guard.
      await http()
        .get(`/v1/orgs/${orgId}/clients/${aliceClient.id}`)
        .set(auth(tokens.bob))
        .expect(404);

      // And nothing changed.
      const still = await http()
        .get(`/v1/orgs/${orgId}/clients/${aliceClient.id}`)
        .set(auth(tokens.owner))
        .expect(200);
      expect(still.body.name).toBe('Alice Private');
    });
  });

  describe('DELETE (soft)', () => {
    it('forbids members and viewers', async () => {
      const c = await createClient(tokens.member, orgId, { name: 'Keep Me' });
      for (const role of ['member', 'viewer'] as const) {
        await http()
          .delete(`/v1/orgs/${orgId}/clients/${c.id}`)
          .set(auth(tokens[role]))
          .expect(403);
      }
      await http()
        .get(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.owner))
        .expect(200);
    });

    it('soft-deletes: hidden everywhere, row kept, second delete is 404', async () => {
      const c = await createClient(tokens.member, orgId, { name: 'Soft Gone' });
      await http()
        .delete(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.admin))
        .expect(204);

      await http()
        .get(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.owner))
        .expect(404);
      await http()
        .patch(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.owner))
        .send({ name: 'Zombie' })
        .expect(404);
      const list = await http()
        .get(`/v1/orgs/${orgId}/clients`)
        .set(auth(tokens.owner))
        .expect(200);
      expect(list.body.map((x: { id: string }) => x.id)).not.toContain(c.id);
      await http()
        .delete(`/v1/orgs/${orgId}/clients/${c.id}`)
        .set(auth(tokens.owner))
        .expect(404);

      // The row still exists, marked deleted: history is preserved.
      const { rows } = await admin.query(
        'SELECT name, deleted_at FROM clients WHERE id = $1',
        [c.id],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].name).toBe('Soft Gone');
      expect(rows[0].deleted_at).not.toBeNull();
    });
  });
});
