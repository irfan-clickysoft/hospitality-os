import { describe, expect, it } from 'vitest';
import { canAssignRole, decide, holdsAnywhere, type Grant, type Limits, type ScopeType } from './authorize.js';
import { ROLE_TEMPLATES, SENSITIVE_PERMISSIONS } from './roles.js';

const LE1 = 'le-1', P1 = 'prop-1', P2 = 'prop-2', D1 = 'dept-1';
const g = (permission: string, scopeType: ScopeType = 'TENANT', scopeId: string | null = null, limits: Limits = {}, over: Partial<Grant> = {}): Grant =>
  ({ permission, scopeType, scopeId, limits, validFrom: new Date('2026-01-01'), validTo: null, ...over });
const NOW = new Date('2026-10-20T10:00:00Z');

describe('decide', () => {
  it('denies by default', () => {
    expect(decide([], { permission: 'folio.view', at: NOW }).effect).toBe('DENY');
  });
  it('tenant-wide grant covers any scope', () => {
    expect(decide([g('folio.view')], { permission: 'folio.view', scope: { propertyId: P1 }, at: NOW }).effect).toBe('ALLOW');
  });
  it('property grant covers only that property and fails closed without a property id', () => {
    const grants = [g('folio.view', 'PROPERTY', P1)];
    expect(decide(grants, { permission: 'folio.view', scope: { propertyId: P1 }, at: NOW }).effect).toBe('ALLOW');
    expect(decide(grants, { permission: 'folio.view', scope: { propertyId: P2 }, at: NOW }).effect).toBe('DENY');
    expect(decide(grants, { permission: 'folio.view', at: NOW }).effect).toBe('DENY'); // tenant-level request
    expect(decide(grants, { permission: 'folio.view', scope: {}, at: NOW }).effect).toBe('DENY');
  });
  it('legal-entity and department grants match their own ids only', () => {
    expect(decide([g('report.view', 'LEGAL_ENTITY', LE1)], { permission: 'report.view', scope: { legalEntityId: LE1, propertyId: P1 }, at: NOW }).effect).toBe('ALLOW');
    expect(decide([g('report.view', 'LEGAL_ENTITY', LE1)], { permission: 'report.view', scope: { legalEntityId: 'other' }, at: NOW }).effect).toBe('DENY');
    expect(decide([g('report.view', 'DEPARTMENT', D1)], { permission: 'report.view', scope: { departmentId: D1 }, at: NOW }).effect).toBe('ALLOW');
  });
  it('honours validity windows', () => {
    const expired = g('folio.view', 'TENANT', null, {}, { validTo: new Date('2026-10-01') });
    const future = g('folio.view', 'TENANT', null, {}, { validFrom: new Date('2026-11-01') });
    expect(decide([expired], { permission: 'folio.view', at: NOW }).effect).toBe('DENY');
    expect(decide([future], { permission: 'folio.view', at: NOW }).effect).toBe('DENY');
  });
  it('limits turn an over-limit request into APPROVAL_REQUIRED, not ALLOW', () => {
    const grants = [g('payment.refund', 'PROPERTY', P1, { maxRefundMinor: 500_000 })];
    const scope = { propertyId: P1 };
    expect(decide(grants, { permission: 'payment.refund', scope, amountMinor: 500_000n, at: NOW }).effect).toBe('ALLOW');
    const over = decide(grants, { permission: 'payment.refund', scope, amountMinor: 500_001n, at: NOW });
    expect(over.effect).toBe('APPROVAL_REQUIRED');
    const disc = decide([g('reservation.modify', 'TENANT', null, { maxDiscountPct: 10 })], { permission: 'reservation.modify', discountPct: 15, at: NOW });
    expect(disc.effect).toBe('APPROVAL_REQUIRED');
  });
  it('a second, more generous matching grant allows the request', () => {
    const grants = [g('payment.refund', 'PROPERTY', P1, { maxRefundMinor: 100 }), g('payment.refund', 'TENANT', null, {})];
    expect(decide(grants, { permission: 'payment.refund', scope: { propertyId: P1 }, amountMinor: 10_000n, at: NOW }).effect).toBe('ALLOW');
  });
  it('a grant of one permission never implies another', () => {
    expect(decide([g('folio.view')], { permission: 'folio.adjust', at: NOW }).effect).toBe('DENY');
  });
});

describe('canAssignRole (privilege escalation)', () => {
  const roleFd = ROLE_TEMPLATES.find((r) => r.key === 'front_desk_agent')!.permissions;
  const scopeP1 = { legalEntityId: LE1, propertyId: P1 };
  const gmGrants = (pid = P1) => [...ROLE_TEMPLATES.find((r) => r.key === 'general_manager')!.permissions].map((p) => g(p, 'PROPERTY', pid));

  it('a GM can assign front desk at their own property', () => {
    expect(canAssignRole(gmGrants(), { rolePermissions: roleFd, scopeType: 'PROPERTY', scopeId: P1, scope: scopeP1, at: NOW }).effect).toBe('ALLOW');
  });
  it('a GM cannot assign at another property', () => {
    expect(canAssignRole(gmGrants(), { rolePermissions: roleFd, scopeType: 'PROPERTY', scopeId: P2, scope: { legalEntityId: LE1, propertyId: P2 }, at: NOW }).effect).toBe('DENY');
  });
  it('a GM cannot assign at tenant scope (broader than their own)', () => {
    expect(canAssignRole(gmGrants(), { rolePermissions: roleFd, scopeType: 'TENANT', scopeId: null, scope: {}, at: NOW }).effect).toBe('DENY');
  });
  it('cannot grant a permission you do not hold (GM lacks tenant.manage)', () => {
    const owner = ROLE_TEMPLATES.find((r) => r.key === 'group_owner')!.permissions;
    const d = canAssignRole(gmGrants(), { rolePermissions: owner, scopeType: 'PROPERTY', scopeId: P1, scope: scopeP1, at: NOW });
    expect(d.effect).toBe('DENY');
  });
  it('needs role.manage even if the actor holds all role permissions', () => {
    const noManage = gmGrants().filter((x) => x.permission !== 'role.manage');
    expect(canAssignRole(noManage, { rolePermissions: roleFd, scopeType: 'PROPERTY', scopeId: P1, scope: scopeP1, at: NOW }).effect).toBe('DENY');
  });
  it('cannot hand out more generous limits than your own', () => {
    const limited = [g('role.manage', 'PROPERTY', P1), g('payment.refund', 'PROPERTY', P1, { maxRefundMinor: 1000 })];
    const base = { rolePermissions: ['payment.refund'], scopeType: 'PROPERTY' as const, scopeId: P1, scope: scopeP1, at: NOW };
    expect(canAssignRole(limited, { ...base, limits: { maxRefundMinor: 1000 } }).effect).toBe('ALLOW');
    expect(canAssignRole(limited, { ...base, limits: { maxRefundMinor: 5000 } }).effect).toBe('DENY');
    expect(canAssignRole(limited, { ...base, limits: {} }).effect).toBe('DENY'); // unlimited > limited
  });
  it('rejects malformed scopes', () => {
    expect(canAssignRole([g('role.manage')], { rolePermissions: [], scopeType: 'PROPERTY', scopeId: null, scope: {}, at: NOW }).effect).toBe('DENY');
    expect(canAssignRole([g('role.manage')], { rolePermissions: [], scopeType: 'TENANT', scopeId: 'x', scope: {}, at: NOW }).effect).toBe('DENY');
  });
  it('an expired role.manage grant cannot be used', () => {
    const exp = [g('role.manage', 'TENANT', null, {}, { validTo: new Date('2026-10-01') }), ...roleFd.map((p) => g(p))];
    expect(canAssignRole(exp, { rolePermissions: roleFd, scopeType: 'PROPERTY', scopeId: P1, scope: scopeP1, at: NOW }).effect).toBe('DENY');
  });
});

describe('role templates', () => {
  it('have unique keys and no duplicate permissions', () => {
    const keys = ROLE_TEMPLATES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of ROLE_TEMPLATES) expect(new Set(r.permissions).size, r.key).toBe(r.permissions.length);
  });
  it('never give frontline roles sensitive permissions', () => {
    for (const k of ['housekeeper', 'kitchen_support', 'gate_security', 'reservation_agent', 'cashier', 'front_desk_agent']) {
      const r = ROLE_TEMPLATES.find((x) => x.key === k)!;
      expect(r.permissions.filter((p) => SENSITIVE_PERMISSIONS.has(p)), k).toEqual([]);
    }
  });
  it('gate security cannot see guest financials or full reservation data', () => {
    const r = ROLE_TEMPLATES.find((x) => x.key === 'gate_security')!;
    expect(r.permissions).not.toContain('reservation.view');
    expect(r.permissions).not.toContain('folio.view');
  });
});

describe('holdsAnywhere', () => {
  it('is true for any active grant at any scope, false otherwise', () => {
    expect(holdsAnywhere([g('guest.view', 'PROPERTY', 'p1')], 'guest.view', NOW)).toBe(true);
    expect(holdsAnywhere([g('guest.view', 'PROPERTY', 'p1')], 'guest.manage', NOW)).toBe(false);
    expect(holdsAnywhere([g('guest.view', 'TENANT', null, {}, { validTo: new Date('2026-10-01') })], 'guest.view', NOW)).toBe(false);
  });
});
