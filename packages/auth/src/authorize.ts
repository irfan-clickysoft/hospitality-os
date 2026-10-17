/**
 * Pure, framework-free authorization decisions. Deny by default; fail closed when scope information is missing.
 * Server-side only: UI permission hints must never be treated as enforcement.
 */
export type ScopeType = 'TENANT' | 'LEGAL_ENTITY' | 'PROPERTY' | 'DEPARTMENT';

export interface Limits {
  maxDiscountPct?: number;
  maxRefundMinor?: number;
  maxAdjustmentMinor?: number;
}

export interface Grant {
  permission: string;
  scopeType: ScopeType;
  scopeId: string | null;
  limits: Limits;
  validFrom: Date;
  validTo: Date | null;
}

/** Where the resource lives. Callers resolve the full chain (property -> legal entity) from the database, never from client input. */
export interface ResourceScope {
  legalEntityId?: string;
  propertyId?: string;
  departmentId?: string;
}

export interface AuthzRequest {
  permission: string;
  scope?: ResourceScope;
  /** Monetary amount involved, in minor units (refund / adjustment checks). */
  amountMinor?: bigint | number;
  discountPct?: number;
  at?: Date;
}

export type Decision =
  | { effect: 'ALLOW' }
  | { effect: 'DENY'; reason: string }
  | { effect: 'APPROVAL_REQUIRED'; reason: string; limit: keyof Limits };

const RANK: Record<ScopeType, number> = { TENANT: 0, LEGAL_ENTITY: 1, PROPERTY: 2, DEPARTMENT: 3 };

function active(g: Grant, at: Date): boolean {
  return g.validFrom <= at && (g.validTo === null || at < g.validTo);
}

/** Does a grant's scope cover the resource's scope? Narrower grants need the matching id on the resource, else no match. */
export function covers(g: Pick<Grant, 'scopeType' | 'scopeId'>, scope: ResourceScope | undefined): boolean {
  switch (g.scopeType) {
    case 'TENANT': return true;
    case 'LEGAL_ENTITY': return !!scope?.legalEntityId && scope.legalEntityId === g.scopeId;
    case 'PROPERTY': return !!scope?.propertyId && scope.propertyId === g.scopeId;
    case 'DEPARTMENT': return !!scope?.departmentId && scope.departmentId === g.scopeId;
  }
}

function breaches(l: Limits, r: AuthzRequest): keyof Limits | null {
  const amt = r.amountMinor === undefined ? undefined : BigInt(r.amountMinor);
  if (r.discountPct !== undefined && l.maxDiscountPct !== undefined && r.discountPct > l.maxDiscountPct) return 'maxDiscountPct';
  if (amt !== undefined && r.permission === 'payment.refund' && l.maxRefundMinor !== undefined && amt > BigInt(l.maxRefundMinor)) return 'maxRefundMinor';
  if (amt !== undefined && r.permission === 'folio.adjust' && l.maxAdjustmentMinor !== undefined && amt > BigInt(l.maxAdjustmentMinor)) return 'maxAdjustmentMinor';
  return null;
}

export function decide(grants: readonly Grant[], req: AuthzRequest): Decision {
  const at = req.at ?? new Date();
  const matching = grants.filter((g) => g.permission === req.permission && active(g, at) && covers(g, req.scope));
  if (matching.length === 0) return { effect: 'DENY', reason: `No active grant of ${req.permission} covering this scope` };
  let firstBreach: keyof Limits | null = null;
  for (const g of matching) {
    const b = breaches(g.limits, req);
    if (!b) return { effect: 'ALLOW' };
    firstBreach ??= b;
  }
  return { effect: 'APPROVAL_REQUIRED', reason: `Request exceeds your ${firstBreach}; a user with approval authority must approve`, limit: firstBreach! };
}

export interface RoleAssignmentRequest {
  /** Permissions contained in the role being assigned. */
  rolePermissions: readonly string[];
  scopeType: ScopeType;
  scopeId: string | null;
  /** Resolved chain for the target scope (e.g., for a PROPERTY: its legalEntityId and propertyId). */
  scope: ResourceScope;
  /** Limits the new assignment would carry. */
  limits?: Limits;
  at?: Date;
}

/** Target scope narrower or equal to the actor's grant scope, given the resolved chain. */
function grantCoversTarget(g: Grant, t: RoleAssignmentRequest): boolean {
  if (g.scopeType === 'TENANT') return true;
  if (RANK[g.scopeType] > RANK[t.scopeType]) return false; // actor's grant narrower than the target scope
  return covers(g, t.scope);
}

/**
 * Privilege-escalation guard. An actor may assign a role only if, at the target scope, they:
 *  1) hold `role.manage`, and
 *  2) hold every permission the role contains, and
 *  3) are not handing out more generous limits than their own.
 */
export function canAssignRole(actor: readonly Grant[], req: RoleAssignmentRequest): Decision {
  const at = req.at ?? new Date();
  if ((req.scopeType === 'TENANT') !== (req.scopeId === null)) return { effect: 'DENY', reason: 'TENANT scope must have no scope id, others must have one' };
  const held = (perm: string) => actor.filter((g) => g.permission === perm && active(g, at) && grantCoversTarget(g, req));
  if (held('role.manage').length === 0) return { effect: 'DENY', reason: 'Missing role.manage at the target scope' };
  for (const p of req.rolePermissions) {
    const gs = held(p);
    if (gs.length === 0) return { effect: 'DENY', reason: `Cannot grant a permission you do not hold at this scope: ${p}` };
    if (req.limits && !gs.some((g) => limitsNoMoreGenerous(req.limits!, g.limits))) {
      return { effect: 'DENY', reason: `Cannot grant more generous limits than your own for ${p}` };
    }
  }
  return { effect: 'ALLOW' };
}

function limitsNoMoreGenerous(want: Limits, own: Limits): boolean {
  for (const k of ['maxDiscountPct', 'maxRefundMinor', 'maxAdjustmentMinor'] as const) {
    const o = own[k];
    if (o === undefined) continue; // actor is unlimited on this dimension
    const w = want[k];
    if (w === undefined || w > o) return false; // wants unlimited or more than the actor has
  }
  return true;
}
