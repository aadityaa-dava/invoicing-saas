import { PasswordService } from './password.service';

describe('PasswordService', () => {
  const service = new PasswordService();

  it('produces an argon2id hash that is not the plaintext', async () => {
    const hashed = await service.hash('correct horse battery staple');
    expect(hashed.startsWith('$argon2id$')).toBe(true);
    expect(hashed).not.toContain('correct horse');
  });

  it('uses a fresh salt, so the same password hashes differently', async () => {
    const a = await service.hash('same-password');
    const b = await service.hash('same-password');
    expect(a).not.toBe(b);
  });

  it('accepts the right password and rejects a wrong one', async () => {
    const hashed = await service.hash('s3cret-passphrase');
    await expect(service.verify(hashed, 's3cret-passphrase')).resolves.toBe(true);
    await expect(service.verify(hashed, 'wrong-passphrase')).resolves.toBe(false);
  });

  it('returns false for an unknown account (null hash)', async () => {
    await expect(service.verify(null, 'anything')).resolves.toBe(false);
  });

  it('returns false for a malformed stored hash instead of throwing', async () => {
    await expect(service.verify('not-a-hash', 'anything')).resolves.toBe(false);
  });
});
