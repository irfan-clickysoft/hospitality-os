/**
 * Offline work queue. Staff act while the signal is down; each action is stored with its true time and replayed in order when the
 * connection returns. The server treats every replay as idempotent, so a duplicate or a retry never double-counts.
 */
export interface QueuedAction {
  id: string; method: 'POST' | 'PUT'; path: string; body?: Record<string, unknown>;
  /** What this action means for the screen (used to show the expected result while it waits). */
  effect: { kind: 'start' | 'finish' | 'release' | 'skip' | 'dnd' | 'issue' | 'lostfound'; taskId?: string; roomId?: string; dnd?: boolean };
  createdAt: string;
}
export interface QueueStore { load(): QueuedAction[]; save(items: QueuedAction[]): void }
export type SendResult = { ok: true } | { ok: false; retry: true } | { ok: false; retry: false; status: number; code: string };
export interface Dropped { action: QueuedAction; status: number; code: string }

export class MemoryStore implements QueueStore {
  private items: QueuedAction[] = [];
  load() { return [...this.items]; }
  save(items: QueuedAction[]) { this.items = [...items]; }
}
export class LocalStore implements QueueStore {
  constructor(private readonly key: string) {}
  load(): QueuedAction[] { try { const v = JSON.parse(localStorage.getItem(this.key) ?? '[]'); return Array.isArray(v) ? v : []; } catch { return []; } }
  save(items: QueuedAction[]) { try { localStorage.setItem(this.key, JSON.stringify(items)); } catch { /* storage full or blocked: the in-memory copy still works for this session */ } }
}

export class OfflineQueue {
  private flushing: Promise<FlushResult> | null = null;
  constructor(private readonly store: QueueStore, private readonly send: (a: QueuedAction) => Promise<SendResult>) {}

  list(): QueuedAction[] { return this.store.load(); }
  add(a: Omit<QueuedAction, 'id' | 'createdAt'> & { createdAt?: string }): QueuedAction {
    const full: QueuedAction = { ...a, id: crypto.randomUUID(), createdAt: a.createdAt ?? new Date().toISOString() };
    this.store.save([...this.store.load(), full]);
    return full;
  }
  /** Sends in order. A temporary failure stops the run (order matters); a permanent refusal drops that one action and carries on. */
  flush(): Promise<FlushResult> {
    this.flushing ??= this.run().finally(() => { this.flushing = null; });
    return this.flushing;
  }
  private async run(): Promise<FlushResult> {
    const out: FlushResult = { sent: 0, dropped: [], stopped: false };
    for (;;) {
      const [next, ...rest] = this.store.load();
      if (!next) break;
      const r = await this.send(next);
      if (r.ok) { out.sent++; this.store.save(rest); }
      else if (r.retry) { out.stopped = true; break; }
      else { out.dropped.push({ action: next, status: r.status, code: r.code }); this.store.save(rest); }
    }
    return out;
  }
}
export interface FlushResult { sent: number; dropped: Dropped[]; stopped: boolean }

/** Shows what the list will look like once the queued actions are accepted. */
export interface TaskLike { id: string; status: string }
export function applyPending<T extends TaskLike>(tasks: T[], pending: readonly QueuedAction[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, { ...t }]));
  for (const p of pending) {
    const t = p.effect.taskId ? byId.get(p.effect.taskId) : undefined;
    if (!t) continue;
    if (p.effect.kind === 'start') t.status = 'IN_PROGRESS';
    else if (p.effect.kind === 'finish') t.status = 'DONE';
    else if (p.effect.kind === 'release') t.status = 'PENDING';
    else if (p.effect.kind === 'skip') t.status = 'SKIPPED';
  }
  return tasks.map((t) => byId.get(t.id)!);
}
