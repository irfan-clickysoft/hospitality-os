import type { Transaction } from 'kysely';
import type { DB } from '@hos/db';

export type Trx = Transaction<DB>;
export type Persona = 'manager' | 'frontdesk' | 'housekeeping' | 'maintenance' | 'accounts' | 'staff';
export type Category = 'management' | 'frontdesk' | 'rooms' | 'finance' | 'sales' | 'risk';
/** How the report is meant to be read: a worklist, a trend, a ledger, a history, a case register or a summary. */
export type Kind = 'operational' | 'analytical' | 'financial' | 'audit' | 'register' | 'executive';
export type ColType = 'text' | 'int' | 'money' | 'date' | 'datetime' | 'time' | 'pct' | 'badge';
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell> & { _res?: string | null };

export interface Col { key: string; label: string; type?: ColType; /** Add up in the totals row. */ total?: boolean; /** Not shown until chosen. */ hidden?: boolean }
export interface Kpi { key: string; label: string; value: string | number; type?: 'int' | 'money' | 'pct' | 'text'; definition: string; /** The same figure for a comparison period. */ compare?: Array<{ label: string; value: string | number }>; tone?: 'ok' | 'warn' | 'bad' }
export interface Result { kpis: Kpi[]; columns: Col[]; rows: Row[]; notes?: string[]; warnings?: string[]; chart?: { x: string; series: Array<{ key: string; label: string }>; kind: 'bar' | 'line' } }

export interface Ctx {
  trx: Trx; tenantId: string; propertyId: string;
  prop: { code: string; name: string; currency: string; timezone: string; businessDate: string; checkIn: string; checkOut: string };
  from: string; to: string; basis: string; params: Record<string, string>;
  /** Holds the permission to see restricted cases at this property. */ canRestricted: boolean;
}
export interface Def {
  id: string; name: string; category: Category; kind: Kind; purpose: string;
  /** Any one of these permissions, held at the property, opens the report. */
  permissions: string[]; roles: Persona[];
  basis: Array<{ id: string; label: string }>;
  range: 'none' | 'today' | 'month' | 'last30' | 'next30' | 'next90';
  params?: Array<{ key: string; label: string; options: Array<{ value: string; label: string }>; default: string }>;
  definitions: Array<{ term: string; text: string }>;
  /** Only the figures; no money, no names — safe to put in a broad email. */
  sensitive?: boolean;
  run: (c: Ctx) => Promise<Result>;
}
export interface Meta {
  id: string; name: string; purpose: string; kind: Kind; category: Category;
  property: { id: string; code: string; name: string }; timezone: string; businessDate: string; asOf: string;
  dateBasis: { id: string; label: string }; from: string | null; to: string | null; params: Record<string, string>;
  currency: string; taxBasis: string; definitionVersion: string; freshness: 'live' | 'closed-day'; generatedBy: string | null;
}
export interface Envelope extends Result { meta: Meta; definitions: Def['definitions']; totals: Row | null }
