export type ColType = 'text' | 'int' | 'money' | 'date' | 'datetime' | 'time' | 'pct' | 'badge';
export interface Col { key: string; label: string; type?: ColType; total?: boolean; hidden?: boolean }
export type Cell = string | number | boolean | null;
export type Row = Record<string, Cell> & { _res?: string | null; _fmt?: string };
export interface Kpi { key: string; label: string; value: string | number; type?: 'int' | 'money' | 'pct' | 'text'; definition: string; compare?: Array<{ label: string; value: string | number }>; tone?: 'ok' | 'warn' | 'bad' }
export interface Param { key: string; label: string; options: Array<{ value: string; label: string }>; default: string }
export interface CatalogItem { id: string; name: string; category: string; kind: string; purpose: string; roles: string[]; basis: Array<{ id: string; label: string }>; range: string; params: Param[] }
export interface Planned { id: string; name: string; category: string; purpose: string; needs: string }
export interface Envelope {
  kpis: Kpi[]; columns: Col[]; rows: Row[]; totals: Row | null; notes?: string[]; warnings?: string[]; definitions: Array<{ term: string; text: string }>;
  chart?: { x: string; series: Array<{ key: string; label: string }>; kind: 'bar' | 'line' };
  meta: { id: string; name: string; purpose: string; kind: string; category: string; property: { id: string; code: string; name: string }; timezone: string; businessDate: string; asOf: string; dateBasis: { id: string; label: string }; from: string | null; to: string | null; params: Record<string, string>; currency: string; taxBasis: string; definitionVersion: string; generatedBy: string | null };
}
