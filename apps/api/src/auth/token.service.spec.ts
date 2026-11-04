import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import type { Env } from '../config/env';
import { TokenService } from './token.service';

const SECRET = 's'.repeat(40);

function build(secret = SECRET) {
  const jwt = new JwtService({ secret });
  const config = { get: () => 900 } as unknown as ConfigService<Env, true>;
  return { jwt, service: new TokenService(jwt, config) };
}

const b64 = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

describe('TokenService', () => {
  it('signs a token that verifies back to the same user', async () => {
    const { service } = build();
    const { token, expiresIn } = await service.signAccessToken('user-1');
    const claims = await service.verifyAccessToken(token);
    expect(claims.sub).toBe('user-1');
    expect(claims.jti).toEqual(expect.any(String));
    expect(expiresIn).toBe(900);
  });

  it('gives every token a different jti', async () => {
    const { service } = build();
    const a = await service.verifyAccessToken(
      (await service.signAccessToken('u')).token,
    );
    const b = await service.verifyAccessToken(
      (await service.signAccessToken('u')).token,
    );
    expect(a.jti).not.toBe(b.jti);
  });

  it('rejects an expired token', async () => {
    const { service, jwt } = build();
    const expired = await jwt.signAsync({}, { subject: 'u', expiresIn: -10 });
    await expect(service.verifyAccessToken(expired)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a tampered token', async () => {
    const { service } = build();
    const { token } = await service.signAccessToken('u');
    const tampered = token.slice(0, -2) + (token.endsWith('aa') ? 'bb' : 'aa');
    await expect(service.verifyAccessToken(tampered)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects a token signed with a different secret', async () => {
    const { service } = build();
    const other = build('o'.repeat(40));
    const { token } = await other.service.signAccessToken('u');
    await expect(service.verifyAccessToken(token)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rejects an unsigned alg:none token', async () => {
    const { service } = build();
    const unsigned = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'u', jti: 'x' })}.`;
    await expect(service.verifyAccessToken(unsigned)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('generates unique 43-character URL-safe opaque tokens', () => {
    const { service } = build();
    const a = service.generateOpaqueToken();
    const b = service.generateOpaqueToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('hashes deterministically to 64 hex characters', () => {
    const { service } = build();
    const hash = service.hashToken('abc');
    expect(hash).toBe(service.hashToken('abc'));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('abc');
  });
});
