import { useEffect, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import { useAction } from '../lib/action.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth } from '../state.js';
import { Badge, ErrorLine, Sheet, Spinner } from '../ui/kit.js';

const fmt = (v: string) => { const [i, d] = v.split('.'); return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${d ? `.${d}` : ''}`; };
const today = (bd: string) => bd;
interface Account { id: string; code: string; name: string; type: string; normalBalance: string; isGroup: boolean; control: string | null; parentCode: string | null; active: boolean }
interface Branch { id: string; name: string }
interface VRow { id: string; voucherNo: string | null; type: string; date: string; postingDate: string; status: string; narration: string; total: string; preparedBy: string | null; preparedById: string; reversesId: string | null; rejectReason: string | null }
interface VLine { lineNo: number; account: string; accountName: string; branch: string; debit: string; credit: string; description: string | null }
interface VFull { id: string; voucherNo: string | null; status: string; narration: string; date: string; postingDate: string; total: string; preparedById: string; rejectReason: string | null; reversal: { id: string; voucherNo: string | null; status: string } | null; lines: VLine[] }
const TONE: Record<string, 'neutral' | 'warn' | 'clean' | 'urgent'> = { DRAFT: 'neutral', SUBMITTED: 'warn', POSTED: 'clean', REJECTED: 'urgent', CANCELLED: 'neutral' };

function useBranches(): Branch[] { const { properties } = useAuth(); return properties.map((x) => ({ id: x.id, name: x.name })); }

/** Journal vouchers: prepared by one person, approved (and posted) by another. A posted voucher is never edited; it is reversed. */
export function FinVouchers() {
  const { t } = useT(); const { property, can, me: auth } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [rows, setRows] = useState<VRow[] | null>(null); const [status, setStatus] = useState(''); const [open, setOpen] = useState<VFull | null>(null); const [editing, setEditing] = useState<VFull | 'new' | null>(null); const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ items: VRow[] }>('GET', `/v1/finance/vouchers${status ? `?status=${status}` : ''}`).then((r) => setRows(r.items)).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);
  const view = async (id: string) => setOpen(await api<VFull>('GET', `/v1/finance/vouchers/${id}`));
  const act = async (path: string, body?: unknown) => { if (!open) return; const call = () => api('POST', `/v1/finance/vouchers/${open.id}/${path}`, body ?? {}); const r = await run(() => (path === 'approve' || path === 'reject' ? withStepUp(call) : call())); if (r) { await view(open.id); void load(); } };
  if (err) return <p className="warnbox" role="alert">{err}</p>;
  if (!rows) return <Spinner />;
  const me = auth?.user.id; const prep = can('finance.prepare'); const appr = can('finance.approve');
  return (
    <section className="stack">
      <div className="row between"><h2>{t('fin.vouchers')}</h2>{prep && <button className="primary" onClick={() => setEditing('new')}>{t('fin.newJv')}</button>}</div>
      <p className="muted">{t('fin.vouchersHelp')}</p>
      <label>{t('fin.status')}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('fin.all')}</option>{['DRAFT', 'SUBMITTED', 'POSTED', 'REJECTED', 'CANCELLED'].map((s) => <option key={s} value={s}>{t(`fin.st.${s}` as never)}</option>)}</select></label>
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.no')}</th><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{t('fin.total')}</th><th scope="col">{t('fin.by')}</th><th scope="col">{t('fin.status')}</th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.none')}</td></tr>}{rows.map((v) => (
          <tr key={v.id}><th scope="row"><button className="link" onClick={() => void view(v.id)}>{v.voucherNo ?? t('fin.draftNo')}</button></th><td dir="ltr">{v.postingDate}</td><td>{v.narration}</td><td dir="ltr">{fmt(v.total)}</td><td>{v.preparedBy}</td><td><Badge tone={TONE[v.status] ?? 'neutral'}>{t(`fin.st.${v.status}` as never)}</Badge></td></tr>))}</tbody></table></div>
      {open && (
        <Sheet title={open.voucherNo ?? t('fin.draftNo')} onClose={() => setOpen(null)} wide>
          <p><Badge tone={TONE[open.status] ?? 'neutral'}>{t(`fin.st.${open.status}` as never)}</Badge> · <span dir="ltr">{open.postingDate}</span></p><p>{open.narration}</p>
          {open.rejectReason && <p className="warnbox">{t('fin.rejected')}: {open.rejectReason}</p>}
          <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.account')}</th><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.debit')}</th><th scope="col">{t('fin.credit')}</th></tr></thead>
            <tbody>{open.lines.map((l) => <tr key={l.lineNo}><th scope="row"><span dir="ltr">{l.account}</span> {l.accountName}</th><td>{l.branch}</td><td dir="ltr">{l.debit === '0.00' ? '' : fmt(l.debit)}</td><td dir="ltr">{l.credit === '0.00' ? '' : fmt(l.credit)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row" colSpan={2}>{t('fin.total')}</th><td dir="ltr">{fmt(open.total)}</td><td dir="ltr">{fmt(open.total)}</td></tr></tfoot></table></div>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions">
            {['DRAFT', 'REJECTED'].includes(open.status) && open.preparedById === me && prep && <><button onClick={() => setEditing(open)}>{t('fin.edit')}</button><button className="primary" disabled={busy} onClick={() => void act('submit')}>{t('fin.submit')}</button><button disabled={busy} onClick={() => void act('cancel')}>{t('fin.cancel')}</button></>}
            {open.status === 'SUBMITTED' && appr && <><button className="primary" disabled={busy} onClick={() => void act('approve')}>{t('fin.approve')}</button><button disabled={busy} onClick={() => { const r = window.prompt(t('fin.rejectWhy')); if (r && r.trim().length >= 3) void act('reject', { reason: r.trim() }); }}>{t('fin.reject')}</button></>}
            {open.status === 'POSTED' && prep && !open.reversal && <button disabled={busy} onClick={async () => { const r = window.prompt(t('fin.reverseWhy')); if (r && r.trim().length >= 3) { const x = await run(() => api<{ id: string }>('POST', `/v1/finance/vouchers/${open.id}/reverse`, { date: today(property!.businessDate), reason: r.trim() })); if (x) { void load(); await view(x.id); } } }}>{t('fin.reverse')}</button>}
            {open.reversal && <span className="muted small">{t('fin.reversedBy')} {open.reversal.voucherNo ?? t('fin.draftNo')}</span>}
          </div>
        </Sheet>)}
      {editing && <VoucherForm initial={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={async (id) => { setEditing(null); void load(); await view(id); }} />}
    </section>
  );
}

interface FLine { account: string; branchId: string; debit: string; credit: string; description: string }
const blank = (): FLine => ({ account: '', branchId: '', debit: '', credit: '', description: '' });
const clean = (v: string) => v.replace(/[^\d.]/g, '');
function VoucherForm({ initial, onClose, onSaved }: { initial: VFull | null; onClose: () => void; onSaved: (id: string) => void | Promise<void> }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const [accts, setAccts] = useState<Account[]>([]); const [date, setDate] = useState(initial?.postingDate ?? property!.businessDate); const [narration, setNarration] = useState(initial?.narration ?? '');
  const [lines, setLines] = useState<FLine[]>(initial ? initial.lines.map((l) => ({ account: l.account, branchId: '', debit: l.debit === '0.00' ? '' : l.debit, credit: l.credit === '0.00' ? '' : l.credit, description: l.description ?? '' })) : [blank(), blank()]);
  useEffect(() => { api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setAccts(r.items.filter((a) => !a.isGroup && a.active))); }, []);
  const num = (v: string) => Math.round((Number(v) || 0) * 100);
  const dr = lines.reduce((s, l) => s + num(l.debit), 0), cr = lines.reduce((s, l) => s + num(l.credit), 0);
  const set = (i: number, p: Partial<FLine>) => setLines(lines.map((l, k) => (k === i ? { ...l, ...p } : l)));
  const save = async () => {
    const body = { type: 'JV', date, narration, lines: lines.filter((l) => l.account).map((l) => ({ account: l.account, branchId: l.branchId || null, ...(l.debit ? { debit: l.debit } : {}), ...(l.credit ? { credit: l.credit } : {}), ...(l.description ? { description: l.description } : {}) })) };
    const r = await run(() => (initial ? api<{ id: string }>('PUT', `/v1/finance/vouchers/${initial.id}`, body) : api<{ id: string }>('POST', '/v1/finance/vouchers', body)));
    if (r) await onSaved(r.id);
  };
  return (
    <Sheet title={initial ? t('fin.edit') : t('fin.newJv')} onClose={onClose} wide sticky>
      <label>{t('fin.date')}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} dir="ltr" /></label>
      <label>{t('fin.narration')}<input value={narration} onChange={(e) => setNarration(e.target.value)} maxLength={500} /></label>
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.account')}</th><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.debit')}</th><th scope="col">{t('fin.credit')}</th></tr></thead>
        <tbody>{lines.map((l, i) => (
          <tr key={i}><td><select aria-label={`${t('fin.account')} ${i + 1}`} value={l.account} onChange={(e) => set(i, { account: e.target.value })}><option value="">—</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td>
            <td><select aria-label={`${t('fin.branch')} ${i + 1}`} value={l.branchId} onChange={(e) => set(i, { branchId: e.target.value })}><option value="">{t('fin.headOffice')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></td>
            <td><input aria-label={`${t('fin.debit')} ${i + 1}`} inputMode="decimal" value={l.debit} onChange={(e) => set(i, { debit: clean(e.target.value), credit: e.target.value ? '' : l.credit })} dir="ltr" /></td>
            <td><input aria-label={`${t('fin.credit')} ${i + 1}`} inputMode="decimal" value={l.credit} onChange={(e) => set(i, { credit: clean(e.target.value), debit: e.target.value ? '' : l.debit })} dir="ltr" /></td></tr>))}</tbody>
        <tfoot><tr><th scope="row" colSpan={2}>{t('fin.total')}</th><td dir="ltr">{(dr / 100).toFixed(2)}</td><td dir="ltr">{(cr / 100).toFixed(2)}</td></tr></tfoot></table></div>
      <div className="row"><button type="button" onClick={() => setLines([...lines, blank()])}>{t('fin.addLine')}</button></div>
      <p className={dr === cr && dr > 0 ? 'okbox' : 'warnbox'} role="status">{dr === cr && dr > 0 ? t('fin.balanced') : t('fin.diff', { n: ((Math.abs(dr - cr)) / 100).toFixed(2) })}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || narration.trim().length < 3} onClick={() => void save()}>{t('fin.saveDraft')}</button></div>
    </Sheet>
  );
}

/** The chart of accounts. */
export function FinAccounts() {
  const { t } = useT(); const { can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [rows, setRows] = useState<Account[] | null>(null); const [f, setF] = useState({ code: '', name: '', type: 'expense', parentCode: '' }); const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setRows(r.items)).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { void load(); }, []);
  if (err) return <p className="warnbox" role="alert">{err}</p>;
  if (!rows) return <Spinner />;
  const setup = can('finance.setup');
  return (
    <section className="stack">
      <h2>{t('fin.accounts')}</h2><p className="muted">{t('fin.accountsHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {rows.length === 0 && setup && <div className="card inner stack"><p>{t('fin.noChart')}</p><button className="primary" disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', '/v1/finance/accounts/starter')))) void load(); }}>{t('fin.loadStarter')}</button></div>}
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.code')}</th><th scope="col">{t('fin.accountName')}</th><th scope="col">{t('fin.type')}</th><th scope="col">{t('fin.normal')}</th><th scope="col"><span className="sr-only">{t('fin.active')}</span></th></tr></thead>
        <tbody>{rows.map((a) => (
          <tr key={a.id}><th scope="row" dir="ltr">{a.code}</th><td style={{ paddingInlineStart: a.isGroup ? 0 : 16, fontWeight: a.isGroup ? 700 : 400 }}>{a.name}{!a.active && <span className="muted"> · {t('fin.off')}</span>}</td><td>{t(`fin.ty.${a.type}` as never)}</td><td>{a.normalBalance === 'DEBIT' ? t('fin.debit') : t('fin.credit')}</td>
            <td>{setup && !a.isGroup && <button className="link" disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('PUT', `/v1/finance/accounts/${a.id}`, { active: !a.active })))) void load(); }}>{a.active ? t('fin.switchOff') : t('fin.switchOn')}</button>}</td></tr>))}</tbody></table></div>
      {setup && rows.length > 0 && (
        <form className="card inner stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => withStepUp(() => api('POST', '/v1/finance/accounts', { code: f.code, name: f.name, type: f.type, ...(f.parentCode ? { parentCode: f.parentCode } : {}) })))) { setF({ code: '', name: '', type: f.type, parentCode: '' }); void load(); } }}>
          <h3>{t('fin.addAccount')}</h3>
          <div className="grid2"><label>{t('fin.code')}<input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })} inputMode="numeric" dir="ltr" /></label><label>{t('fin.accountName')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label></div>
          <div className="grid2"><label>{t('fin.type')}<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, parentCode: '' })}>{['asset', 'liability', 'equity', 'revenue', 'expense'].map((x) => <option key={x} value={x}>{t(`fin.ty.${x.toUpperCase()}` as never)}</option>)}</select></label>
            <label>{t('fin.parent')}<select value={f.parentCode} onChange={(e) => setF({ ...f, parentCode: e.target.value })}><option value="">—</option>{rows.filter((a) => a.isGroup && a.type.toLowerCase() === f.type).map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label></div>
          <div className="actions"><button className="primary" type="submit" disabled={busy || f.code.length < 4 || f.name.trim().length < 2}>{t('fin.addAccount')}</button></div>
        </form>)}
    </section>
  );
}

interface Tb { currency: string; rows: Array<{ code: string; name: string; debit: string; credit: string; openingDr: string; openingCr: string; closingDr: string; closingCr: string }>; totals: { debit: string; credit: string; closingDr: string; closingCr: string }; balanced: boolean }
interface Gl { account: { code: string; name: string }; opening: string; closing: string; rows: Array<{ date: string; voucherNo: string; narration: string; branch: string; debit: string; credit: string; balance: string }> }
const first = (d: string) => `${d.slice(0, 8)}01`;

/** Trial balance and general ledger, for the whole company or one branch. */
export function FinReports() {
  const { t } = useT(); const { property } = useAuth(); const { problem, run } = useAction(); const branches = useBranches();
  const [from, setFrom] = useState(first(property!.businessDate)); const [to, setTo] = useState(property!.businessDate); const [branch, setBranch] = useState(''); const [acct, setAcct] = useState('');
  const [tb, setTb] = useState<Tb | null>(null); const [gl, setGl] = useState<Gl | null>(null);
  const q = `from=${from}&to=${to}${branch ? `&branchId=${branch}` : ''}`;
  const load = async () => { setGl(null); const r = await run(() => api<Tb>('GET', `/v1/finance/reports/trial-balance?${q}`)); if (r) setTb(r); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [from, to, branch]);
  const open = async (code: string) => { setAcct(code); const r = await run(() => api<Gl>('GET', `/v1/finance/reports/general-ledger?account=${code}&${q}`)); if (r) setGl(r); };
  return (
    <section className="stack">
      <h2>{t('fin.reports')}</h2>
      <div className="grid2"><label>{t('fin.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label><label>{t('fin.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label></div>
      <label>{t('fin.branch')}<select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{t('fin.allBranches')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!tb ? <Spinner /> : gl ? (
        <div className="stack"><button className="link" onClick={() => setGl(null)}>‹ {t('fin.trialBalance')}</button><h3><span dir="ltr">{gl.account.code}</span> {gl.account.name}</h3>
          <p className="muted">{t('fin.opening')}: <span dir="ltr">{fmt(gl.opening)}</span> · {t('fin.closing')}: <span dir="ltr">{fmt(gl.closing)}</span></p>
          <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.no')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.debit')}</th><th scope="col">{t('fin.credit')}</th><th scope="col">{t('fin.balance')}</th></tr></thead>
            <tbody>{gl.rows.length === 0 && <tr><td colSpan={7} className="muted">{t('fin.none')}</td></tr>}{gl.rows.map((r, i) => <tr key={i}><td dir="ltr">{r.date}</td><td dir="ltr">{r.voucherNo}</td><td>{r.narration}</td><td>{r.branch}</td><td dir="ltr">{r.debit === '0.00' ? '' : fmt(r.debit)}</td><td dir="ltr">{r.credit === '0.00' ? '' : fmt(r.credit)}</td><td dir="ltr">{fmt(r.balance)}</td></tr>)}</tbody></table></div></div>
      ) : (
        <div className="stack"><h3>{t('fin.trialBalance')}</h3>
          <p className={tb.balanced ? 'okbox' : 'warnbox'} role="status">{tb.balanced ? t('fin.tbOk') : t('fin.tbBad')}</p>
          <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.account')}</th><th scope="col">{t('fin.debit')}</th><th scope="col">{t('fin.credit')}</th><th scope="col">{t('fin.closingDr')}</th><th scope="col">{t('fin.closingCr')}</th></tr></thead>
            <tbody>{tb.rows.length === 0 && <tr><td colSpan={5} className="muted">{t('fin.none')}</td></tr>}{tb.rows.map((r) => <tr key={r.code}><th scope="row"><button className="link" onClick={() => void open(r.code)}><span dir="ltr">{r.code}</span> {r.name}</button></th><td dir="ltr">{fmt(r.debit)}</td><td dir="ltr">{fmt(r.credit)}</td><td dir="ltr">{fmt(r.closingDr)}</td><td dir="ltr">{fmt(r.closingCr)}</td></tr>)}</tbody>
            <tfoot><tr><th scope="row">{t('fin.total')} ({tb.currency})</th><td dir="ltr">{fmt(tb.totals.debit)}</td><td dir="ltr">{fmt(tb.totals.credit)}</td><td dir="ltr">{fmt(tb.totals.closingDr)}</td><td dir="ltr">{fmt(tb.totals.closingCr)}</td></tr></tfoot></table></div>
        </div>)}
    </section>
  );
}

interface Per { month: string; status: string; reason: string | null }
/** Closing a month stops anything being posted to it; reopening needs a reason and is kept in the audit trail. */
export function FinPeriods() {
  const { t } = useT(); const { property, can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [rows, setRows] = useState<Per[] | null>(null); const [limit, setLimit] = useState(''); const [saved, setSaved] = useState(false);
  const load = () => { void api<{ items: Per[] }>('GET', '/v1/finance/periods').then((r) => setRows(r.items)); void api<{ selfApproveLimit: string }>('GET', '/v1/finance/settings').then((s) => setLimit(s.selfApproveLimit)); };
  useEffect(load, []);
  if (!rows) return <Spinner />;
  const cur = property!.businessDate.slice(0, 7); const closed = new Map(rows.map((r) => [r.month, r]));
  const months = Array.from({ length: 12 }, (_, i) => { const d = new Date(`${cur}-01T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - i); return d.toISOString().slice(0, 7); });
  return (
    <section className="stack">
      <h2>{t('fin.periods')}</h2><p className="muted">{t('fin.periodsHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.month')}</th><th scope="col">{t('fin.status')}</th><th scope="col"><span className="sr-only">{t('fin.close')}</span></th></tr></thead>
        <tbody>{months.map((m) => { const c = closed.get(m)?.status === 'CLOSED'; return (
          <tr key={m}><th scope="row" dir="ltr">{m}</th><td><Badge tone={c ? 'urgent' : 'clean'}>{c ? t('fin.closed') : t('fin.openP')}</Badge></td>
            <td>{can('finance.period') && (c
              ? <button disabled={busy} onClick={async () => { const r = window.prompt(t('fin.reopenWhy')); if (r && r.trim().length >= 3 && await run(() => withStepUp(() => api('POST', `/v1/finance/periods/${m}/reopen`, { reason: r.trim() })))) load(); }}>{t('fin.reopen')}</button>
              : <button disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', `/v1/finance/periods/${m}/close`)))) load(); }}>{t('fin.close')}</button>)}</td></tr>); })}</tbody></table></div>
      {can('finance.setup') && (
        <div className="card inner stack"><h3>{t('fin.selfLimit')}</h3><p className="muted small">{t('fin.selfLimitHelp')}</p>
          <label>{t('fin.amount')}<input inputMode="decimal" value={limit} onChange={(e) => { setSaved(false); setLimit(clean(e.target.value)); }} dir="ltr" /></label>
          <div className="actions"><button disabled={busy || !limit} onClick={async () => { if (await run(() => withStepUp(() => api('PUT', '/v1/finance/settings', { selfApproveLimit: limit })))) setSaved(true); }}>{saved ? `✓ ${t('bg.saved')}` : t('common.save')}</button></div></div>)}
    </section>
  );
}
