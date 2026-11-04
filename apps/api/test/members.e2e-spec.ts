import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { Pool } from 'pg';
import { createAdminPool, deleteOrganizations } from './support/admin-db';
import {
  createTestApp,
  isolateRateLimits,
  registerAndLogin,
  TestApp,
} from './support/test-app';

describe('Member management (e2e)', () => {
  let t: TestApp;
  let admin: Pool;
  const emails: string[] = [];
  const orgIds: string[] = [];
  const http = () => request(t.app.getHttpServer());
  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function newUser() {
    const u = await registerAndLogin(t);
    emails.push(u.email);
    const me = await http().get('/v1/me').set(auth(u.accessToken));
    return { ...u, id: me.body.id as string };
  }
  type User = Awaited<ReturnType<typeof newUser>>;

  async function newOrg(owner: User) {
    const res = await http()
      .post('/v1/orgs')
      .set(auth(owner.accessToken))
      .send({ name: 'Members Co' })
      .expect(201);
    orgIds.push(res.body.id);
    return res.body.id as string;
  }

  const add = (actor: User, orgId: string, target: User, role: string) =>
    http()
      .post(`/v1/orgs/${orgId}/members`)
      .set(auth(actor.accessToken))
      .send({ email: target.email, role });
  const change = (actor: User, orgId: string, target: User, role: string) =>
    http()
      .patch(`/v1/orgs/${orgId}/members/${target.id}`)
      .set(auth(actor.accessToken))
      .send({ role });
  const remove = (actor: User, orgId: string, target: User) =>
    http()
      .delete(`/v1/orgs/${orgId}/members/${target.id}`)
      .set(auth(actor.accessToken));
  const roles = async (actor: User, orgId: string) => {
    const res = await http()
      .get(`/v1/orgs/${orgId}/members`)
      .set(auth(actor.accessToken))
      .expect(200);
    return res.body as { userId: string; role: string }[];
  };

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

  // Each test registers several users from one IP; give it fresh counters.
  beforeEach(() => isolateRateLimits(t));

  describe('adding', () => {
    it('adds an existing verified user', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const orgId = await newOrg(alice);
      const res = await add(alice, orgId, bob, 'member').expect(201);
      expect(res.body).toMatchObject({ email: bob.email, role: 'member' });
      expect(await roles(alice, orgId)).toHaveLength(2);
    });

    it('404s for unknown and for unverified accounts', async () => {
      const alice = await newUser();
      const orgId = await newOrg(alice);
      const ghost = { email: `${randomUUID()}@example.test` } as User;
      const res = await add(alice, orgId, ghost, 'member').expect(404);
      expect(res.body.code).toBe('user_not_found');

      const unverified = `${randomUUID()}@example.test`;
      emails.push(unverified);
      await http()
        .post('/v1/auth/signup')
        .send({ email: unverified, password: 'a-long-enough-password' })
        .expect(202);
      await add(alice, orgId, { email: unverified } as User, 'member').expect(
        404,
      );
    });

    it('409s when the user is already a member', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, bob, 'member').expect(201);
      const res = await add(alice, orgId, bob, 'viewer').expect(409);
      expect(res.body.code).toBe('already_member');
    });

    it('lets an admin add a viewer but not an owner', async () => {
      const alice = await newUser();
      const adminUser = await newUser();
      const bob = await newUser();
      const carol = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, adminUser, 'admin').expect(201);

      await add(adminUser, orgId, bob, 'viewer').expect(201);
      const res = await add(adminUser, orgId, carol, 'owner').expect(403);
      expect(res.body.code).toBe('owner_required');
    });

    it('forbids members and viewers from managing members at all', async () => {
      const alice = await newUser();
      const member = await newUser();
      const viewer = await newUser();
      const target = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, member, 'member').expect(201);
      await add(alice, orgId, viewer, 'viewer').expect(201);

      for (const actor of [member, viewer]) {
        const res = await add(actor, orgId, target, 'viewer').expect(403);
        expect(res.body.code).toBe('forbidden');
        await change(actor, orgId, viewer, 'member').expect(403);
        await remove(actor, orgId, viewer).expect(403);
      }
    });
  });

  describe('owner protection', () => {
    it('stops an admin from changing or removing an owner', async () => {
      const alice = await newUser();
      const adminUser = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, adminUser, 'admin').expect(201);

      const demote = await change(adminUser, orgId, alice, 'viewer').expect(403);
      expect(demote.body.code).toBe('owner_required');
      await remove(adminUser, orgId, alice).expect(403);
      expect((await roles(alice, orgId)).find((m) => m.userId === alice.id)!.role)
        .toBe('owner');
    });

    it('stops an admin from promoting anyone to owner, themselves included', async () => {
      const alice = await newUser();
      const adminUser = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, adminUser, 'admin').expect(201);
      await change(adminUser, orgId, adminUser, 'owner').expect(403);
    });

    it('refuses to demote or remove the last owner', async () => {
      const alice = await newUser();
      const orgId = await newOrg(alice);
      const demote = await change(alice, orgId, alice, 'admin').expect(409);
      expect(demote.body.code).toBe('last_owner');
      const del = await remove(alice, orgId, alice).expect(409);
      expect(del.body.code).toBe('last_owner');
      expect(await roles(alice, orgId)).toHaveLength(1);
    });

    it('allows demoting an owner once another owner exists', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, bob, 'owner').expect(201);
      await change(alice, orgId, bob, 'member').expect(200);
      // Now Alice is the only owner again.
      await change(alice, orgId, alice, 'member').expect(409);
    });

    it('never leaves an org ownerless when two owners demote each other at once', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, bob, 'owner').expect(201);

      const [a, b] = await Promise.all([
        change(alice, orgId, bob, 'admin'),
        change(bob, orgId, alice, 'admin'),
      ]);

      // One wins. The loser is refused: 409 (last owner) if it reached the
      // lock first, or 403 if it was already demoted when authorized.
      const statuses = [a.status, b.status].sort();
      expect(statuses[0]).toBe(200);
      expect([403, 409]).toContain(statuses[1]);

      const { rows } = await admin.query(
        "SELECT count(*)::int AS n FROM memberships WHERE org_id = $1 AND role = 'owner'",
        [orgId],
      );
      expect(rows[0].n).toBe(1);
    });

    it('serializes owner changes: a demotion waits for the owner-row lock', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, bob, 'owner').expect(201);

      // Hold the owner rows locked in a separate transaction.
      const holder = await admin.connect();
      try {
        await holder.query('BEGIN');
        await holder.query(
          "SELECT user_id FROM memberships WHERE org_id = $1 AND role = 'owner' FOR UPDATE",
          [orgId],
        );

        let settled = false;
        const pending = change(alice, orgId, bob, 'admin').then((r) => {
          settled = true;
          return r;
        });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(settled).toBe(false); // blocked on the lock, not racing past it

        // While holding the lock, remove Alice's ownership, then release.
        await holder.query(
          "UPDATE memberships SET role = 'admin' WHERE org_id = $1 AND user_id = $2",
          [orgId, alice.id],
        );
        await holder.query('COMMIT');

        // Bob is now the only owner, so demoting him must be refused.
        const res = await pending;
        expect(res.status).toBe(409);
        expect(res.body.code).toBe('last_owner');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });
  });

  describe('changing and removing', () => {
    it('applies a role change on the very next request', async () => {
      const alice = await newUser();
      const viewer = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, viewer, 'viewer').expect(201);

      const write = () =>
        http()
          .post(`/v1/orgs/${orgId}/clients`)
          .set(auth(viewer.accessToken))
          .send({ name: 'Acme' });
      await write().expect(403);
      await change(alice, orgId, viewer, 'member').expect(200);
      await write().expect(201); // same access token, new role
    });

    it('revokes access immediately when a member is removed', async () => {
      const alice = await newUser();
      const bob = await newUser();
      const orgId = await newOrg(alice);
      await add(alice, orgId, bob, 'member').expect(201);
      await http()
        .get(`/v1/orgs/${orgId}`)
        .set(auth(bob.accessToken))
        .expect(200);

      await remove(alice, orgId, bob).expect(204);
      await http()
        .get(`/v1/orgs/${orgId}`)
        .set(auth(bob.accessToken))
        .expect(404); // same token, no longer a member
    });

    it('404s for a missing member and 400s for a malformed id', async () => {
      const alice = await newUser();
      const stranger = await newUser();
      const orgId = await newOrg(alice);
      const res = await remove(alice, orgId, stranger).expect(404);
      expect(res.body.code).toBe('member_not_found');
      await http()
        .delete(`/v1/orgs/${orgId}/members/not-a-uuid`)
        .set(auth(alice.accessToken))
        .expect(400);
    });

    it("cannot reach another organization's members through your own", async () => {
      const alice = await newUser();
      const xavier = await newUser();
      const aliceOrg = await newOrg(alice);
      const xavierOrg = await newOrg(xavier);

      await remove(alice, aliceOrg, xavier).expect(404);
      await change(alice, aliceOrg, xavier, 'viewer').expect(404);
      await remove(alice, xavierOrg, xavier).expect(404); // not Alice's org
      expect(await roles(xavier, xavierOrg)).toHaveLength(1);
    });
  });
});
