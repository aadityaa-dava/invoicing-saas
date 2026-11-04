import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { Pool, PoolClient } from 'pg';

// Local runs read the monorepo-root .env. In CI the variables already exist.
try {
  for (const [k, v] of Object.entries(parseEnv(readFileSync('../../.env', 'utf8')))) process.env[k] ??= v;
} catch {
  // no .env file
}

const appUrl = process.env.DATABASE_URL!; // app_user, what the API uses
const ownerUrl = process.env.MIGRATION_DATABASE_URL!; // app_owner
// Fixtures are inserted as a superuser, which bypasses RLS entirely, so the
// setup never depends on the code under test.
const adminUrl =
  process.env.ADMIN_DATABASE_URL ??
  `postgresql://${process.env.POSTGRES_USER}:${process.env.POSTGRES_PASSWORD}@localhost:${process.env.POSTGRES_PORT}/${process.env.POSTGRES_DB}`;

interface Ctx {
  userId?: string;
  orgId?: string;
}

// Mirrors what the API does: a transaction that sets the tenant context.
async function asTenant<T>(
  pool: Pool,
  ctx: Ctx,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('app.user_id', $1, true), set_config('app.org_id', $2, true)`,
      [ctx.userId ?? '', ctx.orgId ?? ''],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

describe('Row-level security, tested directly against Postgres', () => {
  // One connection only: every test reuses the same session, which is what
  // would expose a tenant setting leaking between pooled requests.
  const app = new Pool({ connectionString: appUrl, max: 1 });
  const owner = new Pool({ connectionString: ownerUrl, max: 1 });
  const admin = new Pool({ connectionString: adminUrl, max: 1 });

  const id = () => randomUUID();
  const tag = id().slice(0, 8);
  const userA = id();
  const userB = id();
  const userBoth = id(); // member of both organizations
  const stranger = id(); // member of nothing
  const orgA = id();
  const orgB = id();
  const clientA1 = id();
  const clientA2 = id();
  const clientB1 = id();

  beforeAll(async () => {
    for (const [uid, name] of [
      [userA, 'a'],
      [userB, 'b'],
      [userBoth, 'both'],
      [stranger, 'stranger'],
    ]) {
      await admin.query(
        `INSERT INTO users (id, email, password_hash, updated_at) VALUES ($1, $2, 'x', now())`,
        [uid, `${name}-${tag}@rls.test`],
      );
    }
    for (const [oid, name] of [
      [orgA, 'A'],
      [orgB, 'B'],
    ]) {
      await admin.query(
        `INSERT INTO organizations (id, name, slug, updated_at) VALUES ($1, $2, $3, now())`,
        [oid, `Org ${name}`, `org-${name}-${tag}`],
      );
    }
    for (const [oid, uid, role] of [
      [orgA, userA, 'owner'],
      [orgB, userB, 'owner'],
      [orgA, userBoth, 'member'],
      [orgB, userBoth, 'member'],
    ]) {
      await admin.query(
        `INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, $4::membership_role)`,
        [id(), oid, uid, role],
      );
    }
    for (const [cid, oid, name] of [
      [clientA1, orgA, 'Alpha 1'],
      [clientA2, orgA, 'Alpha 2'],
      [clientB1, orgB, 'Bravo 1'],
    ]) {
      await admin.query(
        `INSERT INTO clients (id, org_id, name, updated_at) VALUES ($1, $2, $3, now())`,
        [cid, oid, name],
      );
    }
  });

  afterAll(async () => {
    // Cascades remove memberships; organizations cascade to clients.
    await admin.query(`DELETE FROM users WHERE id = ANY($1::uuid[])`, [
      [userA, userB, userBoth, stranger],
    ]);
    await admin.query(`DELETE FROM organizations WHERE id = ANY($1::uuid[])`, [
      [orgA, orgB],
    ]);
    await Promise.all([app.end(), owner.end(), admin.end()]);
  });

  const clientNames = (client: PoolClient) =>
    client
      .query(`SELECT name FROM clients ORDER BY name`)
      .then((r) => r.rows.map((row) => row.name as string));

  describe('the connection role', () => {
    it('is not a superuser and cannot bypass RLS', async () => {
      const { rows } = await app.query(
        `SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user`,
      );
      expect(rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
    });

    it('even the table owner sees nothing without a tenant context (FORCE)', async () => {
      const { rows } = await owner.query(`SELECT count(*)::int AS n FROM clients`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('reading clients', () => {
    it('each tenant sees only its own rows', async () => {
      expect(await asTenant(app, { orgId: orgA }, clientNames)).toEqual([
        'Alpha 1',
        'Alpha 2',
      ]);
      expect(await asTenant(app, { orgId: orgB }, clientNames)).toEqual([
        'Bravo 1',
      ]);
    });

    it('no context at all returns zero rows', async () => {
      expect(await asTenant(app, {}, clientNames)).toEqual([]);
    });

    it('a user context without an organization returns zero rows', async () => {
      expect(await asTenant(app, { userId: userA }, clientNames)).toEqual([]);
    });

    it('never leaks a previous tenant onto the same pooled connection', async () => {
      await asTenant(app, { orgId: orgA }, clientNames);
      // Plain query on the same single connection, outside any transaction.
      const { rows } = await app.query(`SELECT count(*)::int AS n FROM clients`);
      expect(rows[0].n).toBe(0);
    });
  });

  describe('writing clients across tenants', () => {
    it('cannot update another tenant\'s row', async () => {
      const result = await asTenant(app, { orgId: orgA }, (c) =>
        c.query(`UPDATE clients SET name = 'hacked' WHERE id = $1`, [clientB1]),
      );
      expect(result.rowCount).toBe(0);
      const { rows } = await admin.query(`SELECT name FROM clients WHERE id = $1`, [clientB1]);
      expect(rows[0].name).toBe('Bravo 1');
    });

    it('cannot delete another tenant\'s row', async () => {
      const result = await asTenant(app, { orgId: orgA }, (c) =>
        c.query(`DELETE FROM clients WHERE id = $1`, [clientB1]),
      );
      expect(result.rowCount).toBe(0);
      const { rows } = await admin.query(`SELECT 1 FROM clients WHERE id = $1`, [clientB1]);
      expect(rows).toHaveLength(1);
    });

    it('cannot insert a row into another tenant', async () => {
      await expect(
        asTenant(app, { orgId: orgA }, (c) =>
          c.query(
            `INSERT INTO clients (id, org_id, name, updated_at) VALUES ($1, $2, 'planted', now())`,
            [id(), orgB],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('cannot move its own row into another tenant', async () => {
      await expect(
        asTenant(app, { orgId: orgA }, (c) =>
          c.query(`UPDATE clients SET org_id = $1 WHERE id = $2`, [orgB, clientA1]),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('can write to its own tenant', async () => {
      const newId = id();
      await asTenant(app, { orgId: orgA }, (c) =>
        c.query(
          `INSERT INTO clients (id, org_id, name, updated_at) VALUES ($1, $2, 'Alpha 3', now())`,
          [newId, orgA],
        ),
      );
      expect(await asTenant(app, { orgId: orgA }, clientNames)).toContain('Alpha 3');
      await admin.query(`DELETE FROM clients WHERE id = $1`, [newId]);
    });
  });

  describe('memberships', () => {
    const memberUserIds = (client: PoolClient) =>
      client
        .query(`SELECT user_id FROM memberships`)
        .then((r) => r.rows.map((row) => row.user_id as string).sort());

    it('a user without a tenant sees only their own memberships', async () => {
      expect(await asTenant(app, { userId: userA }, memberUserIds)).toEqual([userA]);
      expect(await asTenant(app, { userId: stranger }, memberUserIds)).toEqual([]);
    });

    it('inside a tenant, you see that tenant\'s members and nobody else\'s', async () => {
      const seen = await asTenant(app, { userId: userA, orgId: orgA }, memberUserIds);
      expect(seen).toEqual([userA, userBoth].sort());
      expect(seen).not.toContain(userB);
    });

    it('cannot add yourself to another tenant', async () => {
      await expect(
        asTenant(app, { userId: userA, orgId: orgA }, (c) =>
          c.query(
            `INSERT INTO memberships (id, org_id, user_id, role) VALUES ($1, $2, $3, 'owner')`,
            [id(), orgB, userA],
          ),
        ),
      ).rejects.toThrow(/row-level security/);
    });
  });

  describe('organizations', () => {
    const orgIds = (client: PoolClient) =>
      client
        .query(`SELECT id FROM organizations`)
        .then((r) => r.rows.map((row) => row.id as string).sort());

    it('you see exactly the organizations you belong to', async () => {
      expect(await asTenant(app, { userId: userA }, orgIds)).toEqual([orgA]);
      expect(await asTenant(app, { userId: userBoth }, orgIds)).toEqual([orgA, orgB].sort());
      expect(await asTenant(app, { userId: stranger }, orgIds)).toEqual([]);
    });

    it('the application role cannot delete organizations', async () => {
      await expect(
        asTenant(app, { userId: userA, orgId: orgA }, (c) =>
          c.query(`DELETE FROM organizations WHERE id = $1`, [orgA]),
        ),
      ).rejects.toThrow(/permission denied/);
    });
  });
});
