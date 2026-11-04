import { can, PERMISSIONS, type Permission } from './permissions';

// Mirrors the table in docs/api-design.md. Typed as a full Record, so adding
// a permission without deciding who gets it is a compile error.
// Columns: owner, admin, member, viewer.
const MATRIX: Record<Permission, [boolean, boolean, boolean, boolean]> = {
  'client:read': [true, true, true, true],
  'client:write': [true, true, true, false],
  'client:delete': [true, true, false, false],
  'invoice:read': [true, true, true, true],
  'invoice:write': [true, true, true, false],
  'invoice:send': [true, true, true, false],
  'invoice:void': [true, true, false, false],
  'recurring:manage': [true, true, true, false],
  'member:read': [true, true, true, true],
  'member:manage': [true, true, false, false],
  'audit:read': [true, true, false, false],
  'billing:manage': [true, false, false, false],
  'org:update': [true, true, false, false],
};

const ROLES = ['OWNER', 'ADMIN', 'MEMBER', 'VIEWER'] as const;

describe('permission matrix', () => {
  for (const permission of PERMISSIONS) {
    it.each(ROLES.map((role, i) => [role, MATRIX[permission][i]] as const))(
      `${permission}: %s -> %s`,
      (role, expected) => {
        expect(can(role, permission)).toBe(expected);
      },
    );
  }

  it('never lets a viewer write anything', () => {
    for (const permission of PERMISSIONS) {
      if (!permission.endsWith(':read')) {
        expect(can('VIEWER', permission)).toBe(false);
      }
    }
  });

  it('keeps billing owner-only', () => {
    const holders = ROLES.filter((r) => can(r, 'billing:manage'));
    expect(holders).toEqual(['OWNER']);
  });
});
