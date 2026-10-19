import { BadRequestException } from '@nestjs/common';
import type { ZodType } from 'zod';

/** Parses untrusted input with a Zod schema; failures become a uniform 400 listing every problem. */
export function parse<T>(schema: ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new BadRequestException({ code: 'VALIDATION_FAILED', message: r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') });
  return r.data;
}
