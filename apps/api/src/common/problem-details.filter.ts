import { type ArgumentsHost, Catch, type ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { mapDbError } from './db-errors.js';

const CODES: Record<number, string> = { 400: 'BAD_REQUEST', 401: 'UNAUTHENTICATED', 403: 'PERMISSION_DENIED', 404: 'NOT_FOUND', 409: 'CONFLICT', 412: 'PRECONDITION_FAILED', 422: 'UNPROCESSABLE', 429: 'RATE_LIMITED' };

/** RFC 9457 problem+json for every error. Never leaks internals on 5xx. */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly log = new Logger('Problem');
  catch(raw: unknown, host: ArgumentsHost): void {
    const err = raw instanceof HttpException ? raw : mapDbError(raw) ?? raw;
    const reply = host.switchToHttp().getResponse();
    const req = host.switchToHttp().getRequest();
    const correlationId = (reply.getHeader?.('x-correlation-id') as string | undefined) ?? req?.raw?.requestId;
    let status = 500, code = 'INTERNAL', detail = 'Unexpected error';
    if (err instanceof HttpException) {
      status = err.getStatus();
      const body = err.getResponse() as string | { code?: string; message?: string | string[] };
      code = (typeof body === 'object' && body.code) || CODES[status] || 'ERROR';
      const msg = typeof body === 'string' ? body : body.message;
      detail = Array.isArray(msg) ? msg.join('; ') : msg ?? err.message;
    } else {
      this.log.error(`${req?.method} ${req?.url}: ${(err as Error)?.stack ?? err}`);
    }
    reply.status(status).header('content-type', 'application/problem+json').send({
      type: `https://docs.hospitality-os/errors/${code.toLowerCase()}`, title: code, status, code, detail, correlationId,
    });
  }
}
