import { Injectable } from '@nestjs/common';

/**
 * In-process sliding-window limiter — a first line of defence only. Production adds WAF rate rules and a shared (Redis) limiter,
 * because this one is per-instance. Account lockout (database-backed) is the authoritative brute-force control.
 */
@Injectable()
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  /** Returns true if the call is allowed (and records it). */
  allow(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= limit) { this.hits.set(key, recent); return false; }
    recent.push(now);
    this.hits.set(key, recent);
    if (this.hits.size > 50_000) this.sweep(now, windowMs);
    return true;
  }
  private sweep(now: number, windowMs: number): void {
    for (const [k, v] of this.hits) if (v.every((t) => now - t >= windowMs)) this.hits.delete(k);
  }
}
