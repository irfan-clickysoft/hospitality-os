import type { ResStatus } from '@hos/db';
import { HttpException } from '@nestjs/common';

/**
 * Reservation lifecycle (per room line). "Guaranteed" is NOT a state — it is an attribute (guarantee_type) — so a guaranteed booking
 * can still be confirmed, checked in, cancelled with a fee, or marked no-show without illegal combinations.
 *
 *   OPTION ──confirm──▶ CONFIRMED ──check-in──▶ CHECKED_IN ──check-out──▶ CHECKED_OUT
 *      │                  │  ▲  ▲                  │
 *   expire/cancel      cancel no-show            undo check-in (same day)
 *      ▼                  ▼    │                   ▼
 *   CANCELLED ◀───────────┘  NO_SHOW        (back to CONFIRMED)
 *   CANCELLED / NO_SHOW ──reinstate──▶ CONFIRMED (only if inventory is still available)
 */
export type ResAction = 'CONFIRM' | 'EXPIRE' | 'CANCEL' | 'NO_SHOW' | 'CHECK_IN' | 'CHECK_OUT' | 'REINSTATE' | 'UNDO_CHECK_IN' | 'REOPEN';

const TRANSITIONS: Record<ResAction, { from: readonly ResStatus[]; to: ResStatus }> = {
  CONFIRM:       { from: ['OPTION'], to: 'CONFIRMED' },
  EXPIRE:        { from: ['OPTION'], to: 'CANCELLED' },
  CANCEL:        { from: ['OPTION', 'CONFIRMED'], to: 'CANCELLED' },
  NO_SHOW:       { from: ['CONFIRMED'], to: 'NO_SHOW' },
  CHECK_IN:      { from: ['CONFIRMED'], to: 'CHECKED_IN' },
  CHECK_OUT:     { from: ['CHECKED_IN'], to: 'CHECKED_OUT' },
  REINSTATE:     { from: ['CANCELLED', 'NO_SHOW'], to: 'CONFIRMED' },
  UNDO_CHECK_IN: { from: ['CHECKED_IN'], to: 'CONFIRMED' },
  REOPEN:        { from: ['CHECKED_OUT'], to: 'CHECKED_IN' },
};

export class InvalidTransitionError extends HttpException {
  constructor(readonly from: ResStatus, readonly action: ResAction) {
    super({ code: 'INVALID_STATE_TRANSITION', message: `A ${from.toLowerCase().replace('_', ' ')} reservation cannot be "${action.toLowerCase().replace('_', ' ')}"`, from, action }, 409);
  }
}

export function nextStatus(from: ResStatus, action: ResAction): ResStatus {
  const t = TRANSITIONS[action];
  if (!t || !t.from.includes(from)) throw new InvalidTransitionError(from, action);
  return t.to;
}
export function canDo(from: ResStatus, action: ResAction): boolean { return TRANSITIONS[action]?.from.includes(from) ?? false; }
export function allowedActions(from: ResStatus): ResAction[] { return (Object.keys(TRANSITIONS) as ResAction[]).filter((a) => canDo(from, a)); }

/** Statuses that hold inventory: OPTION holds (`held`), CONFIRMED / CHECKED_IN are sold (`reserved`). */
export const holdsInventory = (s: ResStatus): 'held' | 'reserved' | null => (s === 'OPTION' ? 'held' : s === 'CONFIRMED' || s === 'CHECKED_IN' ? 'reserved' : null);
export const isActive = (s: ResStatus): boolean => s === 'OPTION' || s === 'CONFIRMED' || s === 'CHECKED_IN';

/** The header status is derived from its room lines (cancelled / no-show lines do not count while any line is still live). */
export function deriveStatus(lines: readonly ResStatus[]): ResStatus {
  if (lines.length === 0) throw new RangeError('a reservation needs at least one room line');
  const active = lines.filter(isActive);
  if (active.length) return active.includes('CHECKED_IN') ? 'CHECKED_IN' : active.includes('CONFIRMED') ? 'CONFIRMED' : 'OPTION';
  if (lines.includes('CHECKED_OUT')) return 'CHECKED_OUT';
  if (lines.every((s) => s === 'NO_SHOW')) return 'NO_SHOW';
  return 'CANCELLED';
}
