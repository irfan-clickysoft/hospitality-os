import { Injectable } from '@nestjs/common';

export const CLOCK = Symbol('CLOCK');
export interface ClockLike { now(): number }

/** Wall-clock time source. Injected so cancellation windows, option expiry and deposit deadlines can be tested at exact moments. */
@Injectable()
export class SystemClock implements ClockLike { now(): number { return Date.now(); } }
