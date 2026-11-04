import { Injectable } from '@nestjs/common';
import { hash, verify } from '@node-rs/argon2';

// OWASP minimum for argon2id: 19 MiB memory, 2 iterations, 1 lane.
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

@Injectable()
export class PasswordService {
  private dummyHash: Promise<string> | undefined;

  hash(password: string): Promise<string> {
    return hash(password, OPTIONS);
  }

  // Pass null when the account does not exist. A comparable amount of work is
  // still done so response time does not reveal which emails are registered.
  async verify(storedHash: string | null, password: string): Promise<boolean> {
    if (storedHash === null) {
      this.dummyHash ??= hash('dummy-password-for-timing', OPTIONS);
      await verify(await this.dummyHash, password);
      return false;
    }
    try {
      return await verify(storedHash, password);
    } catch {
      return false;
    }
  }
}
