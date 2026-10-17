import { HttpException } from '@nestjs/common';

/** Maps PostgreSQL integrity errors to stable API errors without leaking SQL details. */
export function mapDbError(err: unknown): HttpException | null {
  const e = err as { code?: string; constraint?: string };
  if (!e || typeof e.code !== 'string' || e.code.length !== 5) return null;
  const c = e.constraint ? ` (${e.constraint})` : '';
  switch (e.code) {
    case '23505': return new HttpException({ code: 'DUPLICATE', message: `That already exists${c}` }, 409);
    case '23P01': return new HttpException({ code: 'OVERLAP', message: `That conflicts with an existing booking or block${c}` }, 409);
    case '23503': return new HttpException({ code: 'REFERENCE_INVALID', message: `A referenced record does not exist or belongs elsewhere${c}` }, 422);
    case '23514': return new HttpException({ code: 'CONSTRAINT_FAILED', message: `A value is outside the allowed range${c}` }, 422);
    case '22P02': case '22007': case '22008': return new HttpException({ code: 'INVALID_INPUT', message: 'A value has an invalid format' }, 400);
    default: return null;
  }
}
