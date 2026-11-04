import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Env } from '../config/env';

export interface AccessTokenClaims {
  sub: string;
  jti: string;
}

@Injectable()
export class TokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  // The access token identifies the user only. Roles and tenant are looked up
  // per request so they can change or be revoked immediately (ADR-0002).
  async signAccessToken(
    userId: string,
  ): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.config.get('ACCESS_TOKEN_TTL_SECONDS', {
      infer: true,
    });
    const token = await this.jwt.signAsync(
      {},
      { subject: userId, jwtid: randomUUID(), expiresIn, algorithm: 'HS256' },
    );
    return { token, expiresIn };
  }

  // The algorithm is pinned, so an unsigned "alg: none" token is rejected.
  async verifyAccessToken(token: string): Promise<AccessTokenClaims> {
    try {
      const payload = await this.jwt.verifyAsync<AccessTokenClaims>(token, {
        algorithms: ['HS256'],
      });
      return { sub: payload.sub, jti: payload.jti };
    } catch {
      throw new UnauthorizedException();
    }
  }

  // 256 bits of randomness, URL-safe. Used for refresh and email tokens.
  generateOpaqueToken(): string {
    return randomBytes(32).toString('base64url');
  }

  // Only this hash is stored, never the raw token.
  hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
