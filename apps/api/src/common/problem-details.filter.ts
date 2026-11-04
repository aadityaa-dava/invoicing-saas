import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Response } from 'express';

// Formats every error as RFC 9457 application/problem+json.
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const response = host.switchToHttp().getResponse<Response>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const payload =
        typeof body === 'object' && body !== null
          ? (body as Record<string, unknown>)
          : {};
      const name = HttpStatus[status] ?? 'ERROR';
      if (typeof payload.retryAfterSeconds === 'number') {
        response.setHeader('Retry-After', String(payload.retryAfterSeconds));
      }
      response
        .status(status)
        .type('application/problem+json')
        .json({
          type: 'about:blank',
          title: name.replaceAll('_', ' '),
          status,
          code:
            typeof payload.code === 'string' ? payload.code : name.toLowerCase(),
          ...(Array.isArray(payload.errors) ? { errors: payload.errors } : {}),
        });
      return;
    }

    // Unexpected error: log details server-side, return nothing sensitive.
    this.logger.error(
      exception instanceof Error ? exception.stack : String(exception),
    );
    response.status(500).type('application/problem+json').json({
      type: 'about:blank',
      title: 'INTERNAL SERVER ERROR',
      status: 500,
      code: 'internal_error',
    });
  }
}
