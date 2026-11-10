import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { Pool } from 'pg';

// Superuser connection, for TEST FIXTURES AND CLEANUP ONLY.
// The application role cannot delete organizations (by design), and the
// table owner is subject to FORCE RLS, so cleanup needs the admin.
const env = parseEnv(
  readFileSync(join(__dirname, '../../../../.env'), 'utf8'),
) as Record<string, string>;

export function createAdminPool(): Pool {
  return new Pool({
    connectionString: `postgresql://${env.POSTGRES_USER}:${env.POSTGRES_PASSWORD}@localhost:${env.POSTGRES_PORT}/${env.POSTGRES_DB}`,
    max: 1,
  });
}

export async function deleteOrganizations(pool: Pool, ids: string[]) {
  if (ids.length === 0) return;
  // Cascades to memberships and clients.
  await pool.query('DELETE FROM organizations WHERE id = ANY($1::uuid[])', [
    ids,
  ]);
}

// Adds a membership directly, bypassing the API. The member-management
// endpoints do not exist yet, and tests need users with specific roles.
export async function addMember(
  pool: Pool,
  orgId: string,
  userId: string,
  role: 'admin' | 'member' | 'viewer',
) {
  await pool.query(
    `INSERT INTO memberships (id, org_id, user_id, role)
     VALUES (gen_random_uuid(), $1, $2, $3)`,
    [orgId, userId, role],
  );
}

// Connection as the restricted application role (what the API runs as).
// One connection only, so tenant context cannot leak between statements.
export function createAppPool(): Pool {
  return new Pool({ connectionString: env.DATABASE_URL, max: 1 });
}
