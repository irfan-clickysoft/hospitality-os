import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { as, createTestApp, provision } from './harness.js';

let app: NestFastifyApplication;
let T: Awaited<ReturnType<typeof provision>>;
beforeAll(async () => { process.env.STEP_UP_DISABLED = '1'; app = await createTestApp(); T = await provision(app, 'stepoff'); });
afterAll(async () => { await app.close(); delete process.env.STEP_UP_DISABLED; });

describe('STEP_UP_DISABLED', () => {
  it('sensitive actions go through without a fresh second-factor code', async () => {
    const O = as(T.tenantId, T.ownerUserId);                         // no x-test-mfa: not freshly verified
    const r = await app.inject({ method: 'POST', url: '/v1/finance/accounts/starter', headers: O });
    expect(r.statusCode, r.body).toBe(200);
  });
});
