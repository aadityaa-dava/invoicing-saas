import { HttpException, HttpStatus } from '@nestjs/common';

export class RateLimitedException extends HttpException {
  constructor(retryAfterSeconds: number) {
    super(
      { code: 'rate_limited', retryAfterSeconds },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
