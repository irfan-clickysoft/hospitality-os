import { describe, expect, it } from 'vitest';
import type { ResStatus } from '@hos/db';
import { allowedActions, canDo, deriveStatus, holdsInventory, InvalidTransitionError, nextStatus, type ResAction } from '../src/reservations/state-machine.js';

const ALL: ResStatus[] = ['OPTION', 'CONFIRMED', 'CHECKED_IN', 'CHECKED_OUT', 'CANCELLED', 'NO_SHOW'];
const ACTIONS: ResAction[] = ['CONFIRM', 'EXPIRE', 'CANCEL', 'NO_SHOW', 'CHECK_IN', 'CHECK_OUT', 'REINSTATE', 'UNDO_CHECK_IN', 'REOPEN'];

describe('reservation state machine', () => {
  it('follows the documented happy paths', () => {
    expect(nextStatus('OPTION', 'CONFIRM')).toBe('CONFIRMED');
    expect(nextStatus('CONFIRMED', 'CHECK_IN')).toBe('CHECKED_IN');
    expect(nextStatus('CHECKED_IN', 'CHECK_OUT')).toBe('CHECKED_OUT');
    expect(nextStatus('CONFIRMED', 'CANCEL')).toBe('CANCELLED');
    expect(nextStatus('CONFIRMED', 'NO_SHOW')).toBe('NO_SHOW');
    expect(nextStatus('OPTION', 'EXPIRE')).toBe('CANCELLED');
    expect(nextStatus('NO_SHOW', 'REINSTATE')).toBe('CONFIRMED');
    expect(nextStatus('CANCELLED', 'REINSTATE')).toBe('CONFIRMED');
  });
  it('rejects every transition that is not in the table (exhaustive check)', () => {
    const allowed = new Set(['OPTION:CONFIRM', 'OPTION:EXPIRE', 'OPTION:CANCEL', 'CONFIRMED:CANCEL', 'CONFIRMED:NO_SHOW', 'CONFIRMED:CHECK_IN', 'CHECKED_IN:CHECK_OUT',
      'CANCELLED:REINSTATE', 'NO_SHOW:REINSTATE', 'CHECKED_IN:UNDO_CHECK_IN', 'CHECKED_OUT:REOPEN']);
    for (const s of ALL) for (const a of ACTIONS) {
      if (allowed.has(`${s}:${a}`)) expect(canDo(s, a), `${s}:${a}`).toBe(true);
      else { expect(canDo(s, a), `${s}:${a}`).toBe(false); expect(() => nextStatus(s, a)).toThrow(InvalidTransitionError); }
    }
  });
  it('a checked-in guest cannot be cancelled or marked no-show, and a cancelled booking cannot be checked in', () => {
    expect(() => nextStatus('CHECKED_IN', 'CANCEL')).toThrow(/cannot be/);
    expect(() => nextStatus('CHECKED_IN', 'NO_SHOW')).toThrow();
    expect(() => nextStatus('CANCELLED', 'CHECK_IN')).toThrow();
    expect(() => nextStatus('CHECKED_OUT', 'CANCEL')).toThrow();
  });
  it('lists the actions a screen may offer', () => {
    expect(allowedActions('CONFIRMED').sort()).toEqual(['CANCEL', 'CHECK_IN', 'NO_SHOW']);
    expect(allowedActions('CANCELLED')).toEqual(['REINSTATE']);
    expect(allowedActions('CHECKED_OUT')).toEqual(['REOPEN']);
  });
  it('options hold inventory as "held"; confirmed and in-house are "reserved"; the rest hold nothing', () => {
    expect(holdsInventory('OPTION')).toBe('held');
    expect(holdsInventory('CONFIRMED')).toBe('reserved'); expect(holdsInventory('CHECKED_IN')).toBe('reserved');
    for (const s of ['CHECKED_OUT', 'CANCELLED', 'NO_SHOW'] as const) expect(holdsInventory(s)).toBeNull();
  });
  it('derives the header status from the room lines', () => {
    expect(deriveStatus(['CONFIRMED'])).toBe('CONFIRMED');
    expect(deriveStatus(['CONFIRMED', 'CHECKED_IN'])).toBe('CHECKED_IN');
    expect(deriveStatus(['CHECKED_OUT', 'CHECKED_IN'])).toBe('CHECKED_IN');
    expect(deriveStatus(['CHECKED_OUT', 'CHECKED_OUT'])).toBe('CHECKED_OUT');
    expect(deriveStatus(['CONFIRMED', 'CANCELLED'])).toBe('CONFIRMED');           // a cancelled line does not hide the live one
    expect(deriveStatus(['CHECKED_OUT', 'CANCELLED'])).toBe('CHECKED_OUT');
    expect(deriveStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
    expect(deriveStatus(['NO_SHOW', 'NO_SHOW'])).toBe('NO_SHOW');
    expect(deriveStatus(['NO_SHOW', 'CANCELLED'])).toBe('CANCELLED');
    expect(deriveStatus(['OPTION', 'CANCELLED'])).toBe('OPTION');
    expect(() => deriveStatus([])).toThrow();
  });
});
