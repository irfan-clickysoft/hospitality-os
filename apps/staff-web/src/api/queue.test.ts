import { describe, expect, it } from 'vitest';
import { applyPending, MemoryStore, OfflineQueue, type QueuedAction, type SendResult } from './queue.js';

const act = (kind: QueuedAction['effect']['kind'], taskId: string): Omit<QueuedAction, 'id' | 'createdAt'> => ({ method: 'POST', path: `/v1/x/${taskId}/${kind}`, effect: { kind, taskId } });

describe('offline queue', () => {
  it('keeps work in order and sends it all when the connection returns', async () => {
    const sent: string[] = [];
    let online = false;
    const q = new OfflineQueue(new MemoryStore(), async (a): Promise<SendResult> => { if (!online) return { ok: false, retry: true }; sent.push(a.path); return { ok: true }; });
    q.add(act('start', 'a')); q.add(act('finish', 'a')); q.add(act('start', 'b'));
    expect(await q.flush()).toEqual({ sent: 0, dropped: [], stopped: true });
    expect(q.list()).toHaveLength(3);                                    // nothing is lost while offline
    online = true;
    expect(await q.flush()).toMatchObject({ sent: 3, stopped: false });
    expect(sent).toEqual(['/v1/x/a/start', '/v1/x/a/finish', '/v1/x/b/start']);
    expect(q.list()).toEqual([]);
  });

  it('stops at the first temporary failure so later actions never overtake earlier ones', async () => {
    const sent: string[] = [];
    const q = new OfflineQueue(new MemoryStore(), async (a): Promise<SendResult> => { if (a.path.endsWith('/finish')) return { ok: false, retry: true }; sent.push(a.path); return { ok: true }; });
    q.add(act('start', 'a')); q.add(act('finish', 'a')); q.add(act('start', 'b'));
    const r = await q.flush();
    expect(r).toMatchObject({ sent: 1, stopped: true });
    expect(q.list().map((x) => x.effect.kind)).toEqual(['finish', 'start']);
  });

  it('drops an action the server permanently refuses, reports it, and carries on', async () => {
    const q = new OfflineQueue(new MemoryStore(), async (a): Promise<SendResult> => (a.effect.taskId === 'a' ? { ok: false, retry: false, status: 409, code: 'TASK_NOT_PENDING' } : { ok: true }));
    q.add(act('start', 'a')); q.add(act('start', 'b'));
    const r = await q.flush();
    expect(r.sent).toBe(1); expect(r.dropped).toHaveLength(1); expect(r.dropped[0]).toMatchObject({ status: 409, code: 'TASK_NOT_PENDING' });
    expect(q.list()).toEqual([]);
  });

  it('never runs two flushes at once', async () => {
    let calls = 0;
    const q = new OfflineQueue(new MemoryStore(), async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { ok: true } as const; });
    q.add(act('start', 'a'));
    const [a, b] = await Promise.all([q.flush(), q.flush()]);
    expect(calls).toBe(1); expect(a).toBe(b);
  });

  it('shows the expected result of queued actions on the list', () => {
    const list = [{ id: 'a', status: 'PENDING' }, { id: 'b', status: 'IN_PROGRESS' }, { id: 'c', status: 'PENDING' }];
    const q = new OfflineQueue(new MemoryStore(), async () => ({ ok: true }));
    q.add(act('start', 'a')); q.add(act('finish', 'b'));
    expect(applyPending(list, q.list()).map((t) => t.status)).toEqual(['IN_PROGRESS', 'DONE', 'PENDING']);
    expect(list[0]!.status).toBe('PENDING');                                // the fetched data itself is not mutated
  });
});
