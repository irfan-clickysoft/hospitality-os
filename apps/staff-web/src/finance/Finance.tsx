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
  const [rows, setRows] = useState<VRow[] | null>(null); const [status, setStatus] = useState(''); const [open, setOpen] = useState<VFull | null>(null); const [editing, setEditing] = useState<VFull | 'new' | null>(null); const [quick, setQuick] = useState(false); const [err, setErr] = useState<string | null>(null);
  const load = () => api<{ items: VRow[] }>('GET', `/v1/finance/vouchers${status ? `?status=${status}` : ''}`).then((r) => setRows(r.items)).catch((e) => setErr(String(e?.message ?? e)));
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [status]);
  const view = async (id: string) => setOpen(await api<VFull>('GET', `/v1/finance/vouchers/${id}`));
  const act = async (path: string, body?: unknown) => { if (!open) return; const call = () => api('POST', `/v1/finance/vouchers/${open.id}/${path}`, body ?? {}); const r = await run(() => (path === 'approve' || path === 'reject' ? withStepUp(call) : call())); if (r) { await view(open.id); void load(); } };
  if (err) return <p className="warnbox" role="alert">{err}</p>;
  if (!rows) return <Spinner />;
  const me = auth?.user.id; const prep = can('finance.prepare'); const appr = can('finance.approve');
  return (
    <section className="stack">
      <div className="row between"><h2>{t('fin.vouchers')}</h2>{prep && <div className="row"><button onClick={() => setQuick(true)}>{t('fin.newQuick')}</button><button className="primary" onClick={() => setEditing('new')}>{t('fin.newJv')}</button></div>}</div>
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
      {quick && <QuickVoucherForm onClose={() => setQuick(false)} onSaved={async (id) => { setQuick(false); void load(); await view(id); }} />}
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
      <YearEnd />
      {can('finance.setup') && (
        <div className="card inner stack"><h3>{t('fin.selfLimit')}</h3><p className="muted small">{t('fin.selfLimitHelp')}</p>
          <label>{t('fin.amount')}<input inputMode="decimal" value={limit} onChange={(e) => { setSaved(false); setLimit(clean(e.target.value)); }} dir="ltr" /></label>
          <div className="actions"><button disabled={busy || !limit} onClick={async () => { if (await run(() => withStepUp(() => api('PUT', '/v1/finance/settings', { selfApproveLimit: limit })))) setSaved(true); }}>{saved ? `✓ ${t('bg.saved')}` : t('common.save')}</button></div></div>)}
    </section>
  );
}

interface PmsMap { key: string; label: string; account: string | null; accountName: string | null }
interface PmsStatus { enabledFrom: string | null; openExceptions: number; mappings: PmsMap[]; paymentAccounts: PmsMap[] }
interface PmsRec { pmsEntries: number; postedEntries: number; pmsNet: string; ledgerNet: string; difference: string; agrees: boolean; openExceptions: number; from: string; to: string }
interface PmsExc { id: string; module: string; reason: string; attempts: number }

/** Sends the money the hotel already records (payments, deposits, charges, taxes, refunds, company and online-agent receipts) to the books, and shows whether the two agree. */
export function FinPosting() {
  const { t } = useT(); const { property, can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [st, setSt] = useState<PmsStatus | null>(null); const [accts, setAccts] = useState<Account[]>([]); const [from, setFrom] = useState(property!.businessDate); const [rec, setRec] = useState<PmsRec | null>(null); const [exc, setExc] = useState<PmsExc[]>([]);
  const load = async () => {
    setSt(await api<PmsStatus>('GET', '/v1/finance/pms')); setAccts((await api<{ items: Account[] }>('GET', '/v1/finance/accounts')).items.filter((a) => !a.isGroup && a.active));
    setExc((await api<{ items: PmsExc[] }>('GET', '/v1/finance/pms/exceptions')).items);
    const d = property!.businessDate; setRec(await api<PmsRec>('GET', `/v1/finance/pms/reconciliation?from=${first(d)}&to=${d}`));
  };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  if (!st) return <Spinner />;
  const setup = can('finance.setup');
  const row = (m: PmsMap) => (
    <tr key={m.key}><th scope="row">{m.label}</th>
      <td><select aria-label={m.label} value={m.account ?? ''} disabled={!setup || busy} onChange={async (e) => { if (await run(() => withStepUp(() => api('PUT', `/v1/finance/pms/map/${encodeURIComponent(m.key)}`, { account: e.target.value || null })))) void load(); }}><option value="">{t('fin.notSet')}</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></td></tr>);
  return (
    <section className="stack">
      <h2>{t('fin.posting')}</h2><p className="muted">{t('fin.postingHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {st.enabledFrom
        ? <div className="card inner stack"><p><Badge tone="clean">{t('fin.on')}</Badge> {t('fin.onFrom', { d: st.enabledFrom })}</p>{setup && <div className="actions"><button disabled={busy} onClick={async () => { if (window.confirm(t('fin.offConfirm')) && await run(() => withStepUp(() => api('POST', '/v1/finance/pms/disable')))) void load(); }}>{t('fin.turnOff')}</button></div>}</div>
        : <div className="card inner stack"><p><Badge tone="neutral">{t('fin.offP')}</Badge> {t('fin.offHelp')}</p>{setup && <><label>{t('fin.startDate')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label><div className="actions"><button className="primary" disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', '/v1/finance/pms/enable', { from })))) void load(); }}>{t('fin.turnOn')}</button></div></>}</div>}
      {rec && st.enabledFrom && (
        <div className="card inner stack"><h3>{t('fin.recon')}</h3>
          <p className={rec.agrees ? 'okbox' : 'warnbox'} role="status">{rec.agrees ? t('fin.reconOk', { n: rec.pmsEntries }) : t('fin.reconBad', { d: fmt(rec.difference), a: rec.pmsEntries, b: rec.postedEntries })}</p></div>)}
      {exc.length > 0 && (
        <div className="card inner stack"><h3>{t('fin.exceptions')} ({exc.length})</h3><p className="muted small">{t('fin.exceptionsHelp')}</p>
          <ul>{exc.slice(0, 10).map((x) => <li key={x.id}>{x.reason}</li>)}</ul>
          {setup && <div className="actions"><button className="primary" disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', '/v1/finance/pms/retry')))) void load(); }}>{t('fin.retry')}</button></div>}</div>)}
      <h3>{t('fin.accountsFor')}</h3>
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.kind')}</th><th scope="col">{t('fin.account')}</th></tr></thead><tbody>{st.mappings.map(row)}{st.paymentAccounts.map(row)}</tbody></table></div>
    </section>
  );
}

interface Bank { id: string; name: string; bankName: string | null; bankBranch: string | null; accountTitle: string | null; iban: string | null; accountNumber: string | null; ownerType: string; ownerName: string | null; accountType: string | null; purpose: string | null; branches: Branch[]; ledger: { code: string; name: string } | null; authorised: { at: string; by: string | null; note: string | null } | null; status: 'NEEDS_SETUP' | 'NEEDS_AUTHORISATION' | 'READY' }
const BANK_TONE: Record<string, 'warn' | 'urgent' | 'clean'> = { NEEDS_SETUP: 'warn', NEEDS_AUTHORISATION: 'urgent', READY: 'clean' };

/** Bank accounts as the books use them: which branches, what for, a ledger account, and (if held in someone else's name) a recorded authorisation. Identifiers are masked unless you may see them. */
export function FinBanks() {
  const { t } = useT(); const { can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const [rows, setRows] = useState<Bank[] | null>(null); const [edit, setEdit] = useState<Bank | null>(null); const [shown, setShown] = useState<Record<string, { iban: string | null; accountNumber: string | null }>>({});
  const load = () => api<{ items: Bank[] }>('GET', '/v1/finance/banks').then((r) => setRows(r.items));
  useEffect(() => { void load(); }, []);
  if (!rows) return <Spinner />;
  const setup = can('finance.setup'); const details = can('finance.bank_details');
  return (
    <section className="stack">
      <h2>{t('fin.banks')}</h2><p className="muted">{t('fin.banksHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {rows.length === 0 && <p className="muted">{t('fin.noBanks')}</p>}
      {rows.map((b) => (
        <div key={b.id} className="card inner stack">
          <div className="row between"><strong>{b.name}</strong><Badge tone={BANK_TONE[b.status]!}>{t(`fin.bs.${b.status}` as never)}</Badge></div>
          <p className="small">{[b.bankName, b.bankBranch].filter(Boolean).join(' · ')}{b.accountTitle ? ` · ${b.accountTitle}` : ''}</p>
          <p className="small" dir="ltr">IBAN {shown[b.id]?.iban ?? b.iban ?? '—'} · {t('fin.acctNo')} {shown[b.id]?.accountNumber ?? b.accountNumber ?? '—'}</p>
          {b.ownerType !== 'COMPANY' && <p className="warnbox">{t('fin.heldBy', { n: b.ownerName ?? '' })}{b.authorised ? ` ${t('fin.authBy', { n: b.authorised.by ?? '' })}` : ''}</p>}
          <p className="small">{b.purpose ? t(`fin.pu.${b.purpose}` as never) : t('fin.noPurpose')} · {b.accountType ? t(`fin.at.${b.accountType}` as never) : t('fin.noType')} · {b.branches.length ? b.branches.map((x) => x.name).join(', ') : t('fin.noBranches')}{b.ledger ? ` · ${t('fin.ledgerIs')} ${b.ledger.code}` : ''}</p>
          <div className="actions">
            {setup && <button onClick={() => setEdit(b)}>{t('fin.setUp')}</button>}
            {setup && !b.ledger && <button disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', `/v1/finance/banks/${b.id}/ledger-account`)))) void load(); }}>{t('fin.makeLedger')}</button>}
            {details && b.ownerType !== 'COMPANY' && !b.authorised && <button disabled={busy} onClick={async () => { const n = window.prompt(t('fin.authWhy')); if (n && n.trim().length >= 5 && await run(() => withStepUp(() => api('POST', `/v1/finance/banks/${b.id}/authorise`, { note: n.trim() })))) void load(); }}>{t('fin.authorise')}</button>}
            {details && <button disabled={busy} onClick={async () => { const r = await run(() => withStepUp(() => api<{ iban: string | null; accountNumber: string | null }>('GET', `/v1/finance/banks/${b.id}/reveal`))); if (r) setShown({ ...shown, [b.id]: r }); }}>{t('fin.reveal')}</button>}
          </div>
        </div>))}
      {edit && <BankSetup bank={edit} branches={branches} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); void load(); }} />}
    </section>
  );
}
function BankSetup({ bank, branches, onClose, onSaved }: { bank: Bank; branches: Branch[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useT(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [type, setType] = useState(bank.accountType ?? 'CURRENT'); const [purpose, setPurpose] = useState(bank.purpose ?? 'COLLECTIONS'); const [sel, setSel] = useState<string[]>(bank.branches.map((x) => x.id));
  return (
    <Sheet title={bank.name} onClose={onClose}>
      <label>{t('fin.accType')}<select value={type} onChange={(e) => setType(e.target.value)}>{['CURRENT', 'SAVINGS', 'OTHER'].map((x) => <option key={x} value={x}>{t(`fin.at.${x}` as never)}</option>)}</select></label>
      <label>{t('fin.purpose')}<select value={purpose} onChange={(e) => setPurpose(e.target.value)}>{['COLLECTIONS', 'EXPENSES', 'BOTH', 'PAYROLL', 'REFUNDS', 'OTHER'].map((x) => <option key={x} value={x}>{t(`fin.pu.${x}` as never)}</option>)}</select></label>
      <fieldset><legend>{t('fin.usedBy')}</legend>{branches.map((b) => <label key={b.id} className="check"><input type="checkbox" checked={sel.includes(b.id)} onChange={(e) => setSel(e.target.checked ? [...sel, b.id] : sel.filter((x) => x !== b.id))} /> {b.name}</label>)}</fieldset>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || sel.length === 0} onClick={async () => { if (await run(() => withStepUp(() => api('PUT', `/v1/finance/banks/${bank.id}`, { accountType: type, purpose, branchIds: sel })))) onSaved(); }}>{t('common.save')}</button></div>
    </Sheet>
  );
}

interface Drawer { id: string; propertyId: string; branch: string; kind: string; name: string; custodian: string | null; openingFloat: string; maxLimit: string | null; balance: string; overLimit: boolean; last: { date: string; status: string; variance: string } | null }
interface Closing { id: string; date: string; branch: string; kind: string; drawer: string; expected: string; counted: string; variance: string; note: string | null; status: string; by: string | null; byId: string }

/** Branch cash and petty cash: the balance the books expect, the daily count, and who approves a difference. */
export function FinCash() {
  const { t } = useT(); const { property, can, me } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const [drawers, setDrawers] = useState<Drawer[] | null>(null); const [closings, setClosings] = useState<Closing[]>([]); const [form, setForm] = useState<{ d: Drawer; counted: string; note: string; date: string } | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [nd, setNd] = useState({ propertyId: '', kind: 'CASH', name: '', openingFloat: '0', maxLimit: '' });
  const load = async () => { setDrawers((await api<{ items: Drawer[] }>('GET', '/v1/finance/cash/drawers')).items); setClosings((await api<{ items: Closing[] }>('GET', '/v1/finance/cash/closings?status=PENDING_APPROVAL')).items); };
  useEffect(() => { void load(); }, []);
  if (!drawers) return <Spinner />;
  const setup = can('finance.setup'); const approve = can('finance.approve');
  return (
    <section className="stack">
      <h2>{t('fin.cash')}</h2><p className="muted">{t('fin.cashHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {msg && <p className="okbox" role="status">{msg}</p>}
      {drawers.length === 0 && <p className="muted">{t('fin.noDrawers')}</p>}
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.drawer')}</th><th scope="col">{t('fin.custodian')}</th><th scope="col">{t('fin.expected')}</th><th scope="col">{t('fin.lastClose')}</th><th scope="col"><span className="sr-only">{t('fin.closeDay')}</span></th></tr></thead>
        <tbody>{drawers.map((d) => (
          <tr key={d.id}><th scope="row">{d.branch}</th><td>{d.name}{d.kind === 'PETTY' ? ` (${t('fin.petty')})` : ''}</td><td>{d.custodian ?? '—'}</td><td dir="ltr">{fmt(d.balance)}{d.overLimit && <Badge tone="warn">{t('fin.overLimit')}</Badge>}</td><td>{d.last ? `${d.last.date} · ${d.last.status === 'CLOSED' || d.last.status === 'APPROVED' ? t('fin.balanced') : t(`fin.cs.${d.last.status}` as never)}` : '—'}</td>
            <td><button onClick={() => { setMsg(null); setForm({ d, counted: '', note: '', date: property!.businessDate }); }}>{t('fin.closeDay')}</button></td></tr>))}</tbody></table></div>
      {form && (
        <Sheet title={`${t('fin.closeDay')}: ${form.d.branch} · ${form.d.name}`} onClose={() => setForm(null)}>
          <label>{t('fin.date')}<input type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} dir="ltr" /></label>
          <label>{t('fin.counted')}<input inputMode="decimal" value={form.counted} onChange={(e) => setForm({ ...form, counted: clean(e.target.value) })} dir="ltr" /></label>
          <label>{t('fin.whyDiff')}<input value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} maxLength={500} /></label>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions"><button onClick={() => setForm(null)}>{t('common.cancel')}</button><button className="primary" disabled={busy || !form.counted} onClick={async () => { const r = await run(() => api<{ status: string; variance: string }>('POST', `/v1/finance/cash/drawers/${form.d.id}/close`, { date: form.date, counted: form.counted, ...(form.note ? { note: form.note } : {}) })); if (r) { setMsg(r.status === 'CLOSED' ? t('fin.closedOk') : t('fin.closedDiff', { n: fmt(r.variance) })); setForm(null); void load(); } }}>{t('fin.closeDay')}</button></div>
        </Sheet>)}
      {closings.length > 0 && (
        <div className="card inner stack"><h3>{t('fin.pendingDiffs')}</h3>
          {closings.map((c) => (
            <div key={c.id} className="stack"><p><strong>{c.branch} · {c.drawer}</strong> · <span dir="ltr">{c.date}</span> · {t('fin.variance')} <span dir="ltr">{fmt(c.variance)}</span> ({t('fin.expected')} <span dir="ltr">{fmt(c.expected)}</span>, {t('fin.counted')} <span dir="ltr">{fmt(c.counted)}</span>)<br /><span className="muted small">{c.by}: {c.note}</span></p>
              {approve && c.byId !== me?.user.id && <div className="actions"><button className="primary" disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', `/v1/finance/cash/closings/${c.id}/decide`, { approve: true })))) void load(); }}>{t('fin.accept')}</button><button disabled={busy} onClick={async () => { const n = window.prompt(t('fin.rejectWhy')); if (n && n.trim().length >= 3 && await run(() => withStepUp(() => api('POST', `/v1/finance/cash/closings/${c.id}/decide`, { approve: false, note: n.trim() })))) void load(); }}>{t('fin.reject')}</button></div>}</div>))}</div>)}
      {setup && (
        <form className="card inner stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => withStepUp(() => api('POST', '/v1/finance/cash/drawers', { propertyId: nd.propertyId, kind: nd.kind, name: nd.name, openingFloat: nd.openingFloat || '0', ...(nd.maxLimit ? { maxLimit: nd.maxLimit } : {}) })))) { setNd({ ...nd, name: '' }); void load(); } }}>
          <h3>{t('fin.addDrawer')}</h3>
          <div className="grid2"><label>{t('fin.branch')}<select value={nd.propertyId} onChange={(e) => setNd({ ...nd, propertyId: e.target.value })}><option value="">—</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
            <label>{t('fin.type')}<select value={nd.kind} onChange={(e) => setNd({ ...nd, kind: e.target.value })}><option value="CASH">{t('fin.cashDrawer')}</option><option value="PETTY">{t('fin.petty')}</option></select></label></div>
          <label>{t('fin.accountName')}<input value={nd.name} onChange={(e) => setNd({ ...nd, name: e.target.value })} /></label>
          <div className="grid2"><label>{t('fin.float')}<input inputMode="decimal" value={nd.openingFloat} onChange={(e) => setNd({ ...nd, openingFloat: clean(e.target.value) })} dir="ltr" /></label><label>{t('fin.maxLimit')}<input inputMode="decimal" value={nd.maxLimit} onChange={(e) => setNd({ ...nd, maxLimit: clean(e.target.value) })} dir="ltr" /></label></div>
          <div className="actions"><button className="primary" type="submit" disabled={busy || !nd.propertyId || nd.name.trim().length < 2}>{t('fin.addDrawer')}</button></div>
        </form>)}
    </section>
  );
}

/** Receipt, payment and transfer vouchers: pick the cash or bank account and the other side; the debits and credits are written for you. */
export function QuickVoucherForm({ onClose, onSaved }: { onClose: () => void; onSaved: (id: string) => void | Promise<void> }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const [accts, setAccts] = useState<Account[]>([]); const [banks, setBanks] = useState<Bank[]>([]);
  const [f, setF] = useState({ type: 'CRV', date: property!.businessDate, narration: '', amount: '', money: 'CASH', branchId: branches[0]?.id ?? '', other: '', to: 'BANK' });
  useEffect(() => { void api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setAccts(r.items.filter((a) => !a.isGroup && a.active))); void api<{ items: Bank[] }>('GET', '/v1/finance/banks').then((r) => setBanks(r.items.filter((b) => b.ledger))); }, []);
  useEffect(() => { if (!f.branchId && branches[0]) setF((x) => ({ ...x, branchId: branches[0]!.id })); }, [branches, f.branchId]);
  const contra = f.type === 'CTV'; const isBank = f.type === 'BRV' || f.type === 'BPV';
  const ref = (v: string) => { const [k, id] = v.split(':'); return k === 'BANK' ? { kind: 'BANK', bankId: id, branchId: f.branchId } : { kind: k, branchId: f.branchId }; };
  const opts = (kinds: string[]) => [...(kinds.includes('CASH') ? [{ v: 'CASH', l: t('fin.cashDrawer') }, { v: 'PETTY', l: t('fin.petty') }] : []), ...(kinds.includes('BANK') ? banks.map((b) => ({ v: `BANK:${b.id}`, l: b.name })) : [])];
  const send = async () => {
    const body = contra ? { type: 'CTV', date: f.date, narration: f.narration, amount: f.amount, from: ref(f.money), to: ref(f.to) } : { type: f.type, date: f.date, narration: f.narration, amount: f.amount, money: ref(f.money), other: f.other };
    const r = await run(() => api<{ id: string }>('POST', '/v1/finance/vouchers/quick', body)); if (r) await onSaved(r.id);
  };
  return (
    <Sheet title={t('fin.newQuick')} onClose={onClose} sticky>
      <label>{t('fin.vtype')}<select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value, money: e.target.value === 'BRV' || e.target.value === 'BPV' ? (banks[0] ? `BANK:${banks[0].id}` : 'BANK:') : 'CASH' })}>{['CRV', 'BRV', 'CPV', 'BPV', 'CTV'].map((x) => <option key={x} value={x}>{t(`fin.vt.${x}` as never)}</option>)}</select></label>
      <div className="grid2"><label>{t('fin.date')}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} dir="ltr" /></label><label>{t('fin.amount')}<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: clean(e.target.value) })} dir="ltr" /></label></div>
      <label>{t('fin.narration')}<input value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} maxLength={500} /></label>
      <label>{t('fin.branch')}<select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
      <label>{contra ? t('fin.from') : isBank ? t('fin.bankAcct') : t('fin.cashAcct')}<select value={f.money} onChange={(e) => setF({ ...f, money: e.target.value })}>{opts(contra ? ['CASH', 'BANK'] : isBank ? ['BANK'] : ['CASH']).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></label>
      {contra
        ? <label>{t('fin.to')}<select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>{opts(['CASH', 'BANK']).map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select></label>
        : <label>{f.type === 'CRV' || f.type === 'BRV' ? t('fin.receivedFor') : t('fin.paidFor')}<select value={f.other} onChange={(e) => setF({ ...f, other: e.target.value })}><option value="">—</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || !f.amount || f.narration.trim().length < 3 || (!contra && !f.other)} onClick={() => void send()}>{t('fin.saveDraft')}</button></div>
    </Sheet>
  );
}

interface Pair { a: string; aId: string; b: string; bId: string; aBooks: string; bBooks: string; difference: string; status: 'AGREE' | 'DIFFERENCE' }
interface IbItem { date: string; voucherNo: string; narration: string; account: string; debit: string; credit: string; balance: string }

/** What each branch owes or is owed by each other branch, as each branch's own books say; plus the two vouchers that create it. */
export function FinInterBranch() {
  const { t } = useT(); const { property, can } = useAuth(); const { problem, run } = useAction(); const branches = useBranches();
  const [to, setTo] = useState(property!.businessDate); const [data, setData] = useState<{ rows: Pair[]; agree: boolean } | null>(null); const [items, setItems] = useState<{ title: string; rows: IbItem[]; balance: string } | null>(null); const [form, setForm] = useState<'transfer' | 'expense' | null>(null);
  const load = async () => { const r = await run(() => api<{ rows: Pair[]; agree: boolean }>('GET', `/v1/finance/interbranch/matrix?to=${to}`)); if (r) setData(r); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [to]);
  const open = async (p: Pair) => { const r = await run(() => api<{ items: IbItem[]; balance: string }>('GET', `/v1/finance/interbranch/items?branchId=${p.aId}&counterpartyId=${p.bId}&to=${to}`)); if (r) setItems({ title: `${p.a} ↔ ${p.b}`, rows: r.items, balance: r.balance }); };
  void branches;
  return (
    <section className="stack">
      <div className="row between"><h2>{t('fin.interbranch')}</h2>{can('finance.prepare') && <div className="row"><button onClick={() => setForm('transfer')}>{t('fin.ibTransfer')}</button><button className="primary" onClick={() => setForm('expense')}>{t('fin.ibExpense')}</button></div>}</div>
      <p className="muted">{t('fin.interbranchHelp')}</p>
      <label>{t('fin.asAt')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!data ? <Spinner /> : (<>
        <p className={data.agree ? 'okbox' : 'warnbox'} role="status">{data.rows.length === 0 ? t('fin.ibNone') : data.agree ? t('fin.ibAgree') : t('fin.ibDiffer')}</p>
        {data.rows.length > 0 && <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.ibPair')}</th><th scope="col">{t('fin.ibFirst')}</th><th scope="col">{t('fin.ibSecond')}</th><th scope="col">{t('fin.ibDiff')}</th></tr></thead>
          <tbody>{data.rows.map((p) => <tr key={`${p.aId}${p.bId}`}><th scope="row"><button className="link" onClick={() => void open(p)}>{p.a} ↔ {p.b}</button></th><td dir="ltr">{fmt(p.aBooks)}</td><td dir="ltr">{fmt(p.bBooks)}</td><td dir="ltr">{p.status === 'AGREE' ? <Badge tone="clean">{t('fin.ibOk')}</Badge> : <Badge tone="urgent">{fmt(p.difference)}</Badge>}</td></tr>)}</tbody></table></div>}
      </>)}
      {items && (
        <Sheet title={items.title} onClose={() => setItems(null)} wide>
          <p className="muted small">{t('fin.ibItemsHelp')}</p>
          <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.no')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{t('fin.debit')}</th><th scope="col">{t('fin.credit')}</th><th scope="col">{t('fin.balance')}</th></tr></thead>
            <tbody>{items.rows.map((r, i) => <tr key={i}><td dir="ltr">{r.date}</td><td dir="ltr">{r.voucherNo}</td><td>{r.narration}</td><td dir="ltr">{r.debit === '0.00' ? '' : fmt(r.debit)}</td><td dir="ltr">{r.credit === '0.00' ? '' : fmt(r.credit)}</td><td dir="ltr">{fmt(r.balance)}</td></tr>)}</tbody></table></div>
        </Sheet>)}
      {form && <InterBranchForm kind={form} onClose={() => setForm(null)} onSaved={() => { setForm(null); void load(); }} />}
    </section>
  );
}

function InterBranchForm({ kind, onClose, onSaved }: { kind: 'transfer' | 'expense'; onClose: () => void; onSaved: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const [accts, setAccts] = useState<Account[]>([]); const [banks, setBanks] = useState<Bank[]>([]);
  const [f, setF] = useState({ date: property!.businessDate, narration: '', amount: '', a: branches[0]?.id ?? '', aMoney: 'CASH', b: branches[1]?.id ?? branches[0]?.id ?? '', bMoney: 'CASH', account: '', vendor: '', invoiceNo: '' });
  useEffect(() => { void api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setAccts(r.items.filter((a) => !a.isGroup && a.active && a.type === 'EXPENSE'))); void api<{ items: Bank[] }>('GET', '/v1/finance/banks').then((r) => setBanks(r.items.filter((b) => b.ledger))); }, []);
  const ref = (v: string) => { const [k, id] = v.split(':'); return k === 'BANK' ? { kind: 'BANK', bankId: id } : { kind: k }; };
  const moneyOpts = [{ v: 'CASH', l: t('fin.cashDrawer') }, { v: 'PETTY', l: t('fin.petty') }, ...banks.map((b) => ({ v: `BANK:${b.id}`, l: b.name }))];
  const send = async () => {
    const r = kind === 'transfer'
      ? await run(() => api('POST', '/v1/finance/interbranch/transfer', { date: f.date, narration: f.narration, amount: f.amount, fromBranchId: f.a, from: ref(f.aMoney), toBranchId: f.b, to: ref(f.bMoney) }))
      : await run(() => api('POST', '/v1/finance/interbranch/expense', { date: f.date, narration: f.narration, amount: f.amount, paidByBranchId: f.a, paidWith: ref(f.aMoney), expenseBranchId: f.b, expenseAccount: f.account, vendor: f.vendor, ...(f.invoiceNo ? { invoiceNo: f.invoiceNo } : {}) }));
    if (r) onSaved();
  };
  const sel = (v: string, set: (x: string) => void, opts: Array<{ v: string; l: string }>) => <select value={v} onChange={(e) => set(e.target.value)}>{opts.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>;
  const br = branches.map((b) => ({ v: b.id, l: b.name }));
  return (
    <Sheet title={kind === 'transfer' ? t('fin.ibTransfer') : t('fin.ibExpense')} onClose={onClose} sticky>
      <div className="grid2"><label>{t('fin.date')}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} dir="ltr" /></label><label>{t('fin.amount')}<input inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: clean(e.target.value) })} dir="ltr" /></label></div>
      <label>{t('fin.narration')}<input value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} maxLength={500} /></label>
      <div className="grid2"><label>{kind === 'transfer' ? t('fin.ibFromBranch') : t('fin.ibPaidBy')}{sel(f.a, (x) => setF({ ...f, a: x }), br)}</label><label>{kind === 'transfer' ? t('fin.ibFromMoney') : t('fin.ibPaidWith')}{sel(f.aMoney, (x) => setF({ ...f, aMoney: x }), moneyOpts)}</label></div>
      {kind === 'transfer'
        ? <div className="grid2"><label>{t('fin.ibToBranch')}{sel(f.b, (x) => setF({ ...f, b: x }), br)}</label><label>{t('fin.ibToMoney')}{sel(f.bMoney, (x) => setF({ ...f, bMoney: x }), moneyOpts)}</label></div>
        : <>
          <div className="grid2"><label>{t('fin.ibExpenseFor')}{sel(f.b, (x) => setF({ ...f, b: x }), br)}</label><label>{t('fin.ibExpenseAcct')}<select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">—</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label></div>
          <div className="grid2"><label>{t('fin.ibVendor')}<input value={f.vendor} onChange={(e) => setF({ ...f, vendor: e.target.value })} maxLength={120} /></label><label>{t('fin.ibInvoice')}<input value={f.invoiceNo} onChange={(e) => setF({ ...f, invoiceNo: e.target.value })} maxLength={60} /></label></div></>}
      <p className="muted small">{t('fin.ibSecond2')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || !f.amount || f.narration.trim().length < 3 || f.a === f.b || (kind === 'expense' && (!f.account || f.vendor.trim().length < 2))} onClick={() => void send()}>{t('fin.saveDraft')}</button></div>
    </Sheet>
  );
}

interface RLine { id: string; date: string; narration: string; reference: string | null; in: string; out: string; direction: 'IN' | 'OUT'; balance: string | null; status: string; matchedTo: string[]; suspense: string | null; note: string | null }
interface Cand { id: string; date: string; voucherNo: string | null; narration: string; in: string; out: string }
interface RSum { statement: string; ledger: string; booksOnlyReceipts: string; booksOnlyPayments: string; statementOnlyCredits: string; statementOnlyDebits: string; adjusted: string; difference: string; reconciled: boolean; booksOnlyCount: number; statementOnlyCount: number; signOff: { id: string; status: string } | null }

/** Bank statement against the books: import a CSV file, see what matches by itself, settle the rest by hand, then sign off the month. */
export function FinRecon() {
  const { t } = useT(); const { property, can, me } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [banks, setBanks] = useState<Bank[] | null>(null); const [bankId, setBankId] = useState(''); const [status, setStatus] = useState('UNMATCHED'); const [lines, setLines] = useState<RLine[]>([]); const [locked, setLocked] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const [to, setTo] = useState(property!.businessDate); const [bal, setBal] = useState(''); const [sum, setSum] = useState<RSum | null>(null); const [match, setMatch] = useState<{ line: RLine; cands: Cand[]; sel: string[] } | null>(null);
  useEffect(() => { void api<{ items: Bank[] }>('GET', '/v1/finance/banks').then((r) => { const ok = r.items.filter((b) => b.ledger); setBanks(ok); if (ok[0]) setBankId(ok[0].id); else setBanks([]); }); }, []);
  const loadLines = async () => { if (!bankId) return; const r = await run(() => api<{ items: RLine[]; locked: string | null }>('GET', `/v1/finance/bank/lines?bankId=${bankId}${status ? `&status=${status}` : ''}`)); if (r) { setLines(r.items); setLocked(r.locked); } };
  useEffect(() => { setSum(null); void loadLines(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [bankId, status]);
  if (!banks) return <Spinner />;
  const prep = can('finance.prepare'); const appr = can('finance.approve');
  const upload = async (f: File | undefined) => { if (!f) return; const csv = await f.text(); const r = await run(() => api<{ added: number; duplicates: number; autoMatched: number }>('POST', '/v1/finance/bank/statements', { bankId, filename: f.name, csv })); if (r) { setMsg(t('fin.imported', { a: r.added, d: r.duplicates, m: r.autoMatched })); void loadLines(); } };
  const calc = async () => { const r = await run(() => api<RSum>('GET', `/v1/finance/bank/summary?bankId=${bankId}&to=${to}&statementBalance=${bal}`)); if (r) setSum(r); };
  const openMatch = async (l: RLine) => { const r = await run(() => api<{ items: Cand[] }>('GET', `/v1/finance/bank/ledger?bankId=${bankId}&to=${to}`)); if (r) setMatch({ line: l, cands: r.items.filter((c) => (l.direction === 'IN' ? c.in !== '0.00' : c.out !== '0.00')), sel: [] }); };
  const act = async (l: RLine, path: string, body: object, sensitive = false) => { const call = () => api('POST', `/v1/finance/bank/lines/${l.id}/${path}`, body); if (await run(() => (sensitive ? withStepUp(call) : call()))) void loadLines(); };
  const total = match ? match.cands.filter((c) => match.sel.includes(c.id)).reduce((s, c) => s + Math.round(Number(match.line.direction === 'IN' ? c.in : c.out) * 100), 0) : 0;
  const want = match ? Math.round(Number(match.line.direction === 'IN' ? match.line.in : match.line.out) * 100) : 0;
  return (
    <section className="stack">
      <h2>{t('fin.recon2')}</h2><p className="muted">{t('fin.recon2Help')}</p>
      {banks.length === 0 ? <p className="warnbox">{t('fin.noLedgerBanks')}</p> : (<>
        <label>{t('fin.bankAcct')}<select value={bankId} onChange={(e) => setBankId(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        {prep && <label>{t('fin.importCsv')}<input type="file" accept=".csv,text/csv,text/plain" disabled={busy} onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} /></label>}
        <ErrorLine code={problem?.code} detail={problem?.detail} />
        {msg && <p className="okbox" role="status">{msg}</p>}
        <div className="card inner stack"><h3>{t('fin.recStatement')}</h3>
          <div className="grid2"><label>{t('fin.asAt')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label><label>{t('fin.stmtBalance')}<input inputMode="decimal" value={bal} onChange={(e) => setBal(e.target.value.replace(/[^\d.-]/g, ''))} dir="ltr" /></label></div>
          <div className="actions"><button disabled={busy || !bal} onClick={() => void calc()}>{t('fin.check')}</button></div>
          {sum && (<>
            <table className="nighttable small"><tbody>
              <tr><th scope="row">{t('fin.stmtBalance')}</th><td dir="ltr">{fmt(sum.statement)}</td></tr><tr><th scope="row">+ {t('fin.booksOnlyIn')} ({sum.booksOnlyCount})</th><td dir="ltr">{fmt(sum.booksOnlyReceipts)}</td></tr><tr><th scope="row">− {t('fin.booksOnlyOut')}</th><td dir="ltr">{fmt(sum.booksOnlyPayments)}</td></tr>
              <tr><th scope="row">− {t('fin.stmtOnlyIn')} ({sum.statementOnlyCount})</th><td dir="ltr">{fmt(sum.statementOnlyCredits)}</td></tr><tr><th scope="row">+ {t('fin.stmtOnlyOut')}</th><td dir="ltr">{fmt(sum.statementOnlyDebits)}</td></tr>
              <tr><th scope="row">{t('fin.adjusted')}</th><td dir="ltr">{fmt(sum.adjusted)}</td></tr><tr><th scope="row">{t('fin.ledgerBal')}</th><td dir="ltr">{fmt(sum.ledger)}</td></tr></tbody></table>
            <p className={sum.reconciled ? 'okbox' : 'warnbox'} role="status">{sum.reconciled ? t('fin.reconciled') : t('fin.notReconciled', { n: fmt(sum.difference) })}</p>
            {sum.signOff ? <p><Badge tone={sum.signOff.status === 'APPROVED' ? 'clean' : 'warn'}>{sum.signOff.status === 'APPROVED' ? t('fin.signedOff') : t('fin.waitingSign')}</Badge></p> : null}
            <div className="actions">
              {prep && sum.reconciled && !sum.signOff && <button className="primary" disabled={busy} onClick={async () => { if (await run(() => api('POST', '/v1/finance/bank/reconciliations', { bankId, to, statementBalance: bal }))) void calc(); }}>{t('fin.sendSign')}</button>}
              {appr && sum.signOff?.status === 'PENDING' && <button className="primary" disabled={busy} onClick={async () => { if (await run(() => withStepUp(() => api('POST', `/v1/finance/bank/reconciliations/${sum.signOff!.id}/approve`)))) void calc(); }}>{t('fin.signOff')}</button>}
            </div></>)}
        </div>
        <label>{t('fin.status')}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="UNMATCHED">{t('fin.rs.UNMATCHED')}</option><option value="MATCHED">{t('fin.rs.MATCHED')}</option><option value="IGNORED">{t('fin.rs.IGNORED')}</option><option value="">{t('fin.all')}</option></select></label>
        {locked && <p className="muted small">{t('fin.lockedTo', { d: locked })}</p>}
        <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{t('fin.in')}</th><th scope="col">{t('fin.out')}</th><th scope="col">{t('fin.status')}</th><th scope="col"><span className="sr-only">{t('fin.actions')}</span></th></tr></thead>
          <tbody>{lines.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.none')}</td></tr>}{lines.map((l) => (
            <tr key={l.id}><td dir="ltr">{l.date}</td><td>{l.narration}{l.reference ? ` · ${l.reference}` : ''}{l.matchedTo.length > 0 && <div className="muted small">{l.matchedTo.join(', ')}</div>}</td><td dir="ltr">{l.direction === 'IN' ? fmt(l.in) : ''}</td><td dir="ltr">{l.direction === 'OUT' ? fmt(l.out) : ''}</td><td><Badge tone={l.status === 'MATCHED' ? 'clean' : l.status === 'IGNORED' ? 'neutral' : 'warn'}>{t(`fin.rs.${l.status}` as never)}</Badge></td>
              <td>{prep && l.status === 'UNMATCHED' && <div className="row"><button className="link" onClick={() => void openMatch(l)}>{t('fin.matchBtn')}</button>{appr && l.direction === 'IN' && <button className="link" onClick={() => void act(l, 'book', { kind: 'SUSPENSE' }, true)}>{t('fin.toQueue')}</button>}{appr && l.direction === 'OUT' && <button className="link" onClick={() => void act(l, 'book', { kind: 'CHARGE' }, true)}>{t('fin.asCharge')}</button>}<button className="link" onClick={() => { const r = window.prompt(t('fin.ignoreWhy')); if (r && r.trim().length >= 3) void act(l, 'ignore', { reason: r.trim() }); }}>{t('fin.ignore')}</button></div>}
                {prep && l.status === 'MATCHED' && !l.matchedTo.some((m) => m.includes('statement')) && <button className="link" onClick={() => { const r = window.prompt(t('fin.unmatchWhy')); if (r && r.trim().length >= 3) void act(l, 'unmatch', { reason: r.trim() }); }}>{t('fin.unmatch')}</button>}</td></tr>))}</tbody></table></div></>)}
      {match && (
        <Sheet title={t('fin.matchTitle', { n: fmt(match.line.direction === 'IN' ? match.line.in : match.line.out) })} onClose={() => setMatch(null)} wide>
          <p className="muted small">{t('fin.matchHelp')}</p>
          <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col" /><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.no')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{match.line.direction === 'IN' ? t('fin.in') : t('fin.out')}</th></tr></thead>
            <tbody>{match.cands.map((c) => <tr key={c.id}><td><input type="checkbox" aria-label={c.voucherNo ?? c.narration} checked={match.sel.includes(c.id)} onChange={(e) => setMatch({ ...match, sel: e.target.checked ? [...match.sel, c.id] : match.sel.filter((x) => x !== c.id) })} /></td><td dir="ltr">{c.date}</td><td dir="ltr">{c.voucherNo}</td><td>{c.narration}</td><td dir="ltr">{fmt(match.line.direction === 'IN' ? c.in : c.out)}</td></tr>)}</tbody></table></div>
          <p className={total === want && want > 0 ? 'okbox' : 'warnbox'} role="status">{t('fin.picked', { a: (total / 100).toFixed(2), b: (want / 100).toFixed(2) })}</p>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions"><button onClick={() => setMatch(null)}>{t('common.cancel')}</button><button className="primary" disabled={busy || total !== want || want === 0} onClick={async () => { if (await run(() => api('POST', `/v1/finance/bank/lines/${match.line.id}/match`, { entryIds: match.sel }))) { setMatch(null); void loadLines(); } }}>{t('fin.matchBtn')}</button></div>
        </Sheet>)}
      {me ? null : null}
    </section>
  );
}

interface SItem { id: string; amount: string; status: string; note: string | null; owner: string | null; date: string; narration: string; reference: string | null; bank: string; ageDays: number; alert: string | null }
/** Money that reached the bank without a known source. It waits here, with its age, until someone finds out whose it is and allocates it. */
export function FinUnallocated() {
  const { t } = useT(); const { can } = useAuth(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const [rows, setRows] = useState<SItem[] | null>(null); const [accts, setAccts] = useState<Account[]>([]); const [f, setF] = useState<{ item: SItem; account: string; branchId: string; reason: string } | null>(null); const [made, setMade] = useState<string | null>(null);
  const load = () => api<{ items: SItem[] }>('GET', '/v1/finance/bank/suspense').then((r) => setRows(r.items));
  useEffect(() => { void load(); void api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setAccts(r.items.filter((a) => !a.isGroup && a.active && a.control !== 'SUSPENSE'))); }, []);
  if (!rows) return <Spinner />;
  return (
    <section className="stack">
      <h2>{t('fin.unalloc')}</h2><p className="muted">{t('fin.unallocHelp')}</p>
      {made && <p className="okbox" role="status">{t('fin.allocMade')}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.bankAcct')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{t('fin.amount')}</th><th scope="col">{t('fin.age')}</th><th scope="col"><span className="sr-only">{t('fin.actions')}</span></th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.none')}</td></tr>}{rows.map((r) => (
          <tr key={r.id}><td dir="ltr">{r.date}</td><td>{r.bank}</td><td>{r.narration}{r.reference ? ` · ${r.reference}` : ''}{r.note ? <div className="muted small">{r.note}</div> : null}</td><td dir="ltr">{fmt(r.amount)}</td><td><Badge tone={r.alert === 'SEVEN' ? 'urgent' : r.alert === 'THREE' ? 'warn' : 'neutral'}>{t('fin.days', { n: r.ageDays })}</Badge></td>
            <td>{can('finance.prepare') && r.status === 'OPEN' ? <button onClick={() => setF({ item: r, account: '', branchId: branches[0]?.id ?? '', reason: '' })}>{t('fin.allocate')}</button> : <Badge tone="warn">{t('fin.allocating')}</Badge>}</td></tr>))}</tbody></table></div>
      {f && (
        <Sheet title={`${t('fin.allocate')}: ${fmt(f.item.amount)}`} onClose={() => setF(null)}>
          <p className="muted small">{f.item.narration}</p>
          <label>{t('fin.paidFor')}<select value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">—</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label>
          <label>{t('fin.branch')}<select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
          <label>{t('fin.evidence')}<input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} maxLength={300} /></label>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions"><button onClick={() => setF(null)}>{t('common.cancel')}</button><button className="primary" disabled={busy || !f.account || f.reason.trim().length < 5} onClick={async () => { const r = await run(() => api<{ voucherId: string }>('POST', `/v1/finance/bank/suspense/${f.item.id}/allocate`, { account: f.account, branchId: f.branchId || null, reason: f.reason.trim() })); if (r) { setMade(r.voucherId); setF(null); void load(); } }}>{t('fin.allocate')}</button></div>
        </Sheet>)}
    </section>
  );
}

interface DashCard { revenue: string; expenses: string; profit: string; cash: string; bank: string; receivables: string; payables: string; advances: string }
interface Dash { currency: string; from: string; to: string; total: DashCard; branches: Array<DashCard & { id: string; name: string }>; trend: Array<{ month: string; revenue: string; expenses: string; profit: string }>; alerts: Record<string, number> }
const num = (v: string) => Number(v.replace(/,/g, ''));

/** The owner's view: the money in and out, what is held, how each branch is doing, and what needs attention. */
export function FinDashboard() {
  const { t } = useT(); const { property } = useAuth(); const { problem, run } = useAction();
  const [period, setPeriod] = useState<'day' | 'week' | 'month' | 'year'>('month'); const [d, setD] = useState<Dash | null>(null);
  useEffect(() => { void run(() => api<Dash>('GET', `/v1/finance/reports/dashboard?period=${period}&date=${property!.businessDate}`)).then((r) => r && setD(r)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [period]);
  const go = (tab: string) => { window.location.hash = `/finance?tab=${tab}`; };
  const alerts: Array<[string, string, string]> = d ? [['vouchersWaiting', 'vouchers', 'fin.al.vouchers'], ['cashDifferences', 'cash', 'fin.al.cash'], ['unallocatedOver3Days', 'unallocated', 'fin.al.unalloc'], ['unmatchedBankLines', 'recon', 'fin.al.unmatched'], ['postingExceptions', 'posting', 'fin.al.posting'], ['interBranchDifferences', 'interbranch', 'fin.al.ib']] : [];
  const max = d ? Math.max(1, ...d.trend.flatMap((x) => [num(x.revenue), num(x.expenses)])) : 1;
  const kpi = (label: string, v: string) => <div className="card inner" key={label}><div className="muted small">{label}</div><div className="big" dir="ltr">{fmt(v)}</div></div>;
  return (
    <section className="stack">
      <h2>{t('fin.dashboard')}</h2>
      <div className="row" role="group" aria-label={t('fin.period')}>{(['day', 'week', 'month', 'year'] as const).map((p) => <button key={p} className={period === p ? 'primary' : ''} onClick={() => setPeriod(p)}>{t(`fin.pd.${p}` as never)}</button>)}</div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!d ? <Spinner /> : (<>
        <p className="muted small" dir="ltr">{d.from} → {d.to} · {d.currency}</p>
        <div className="grid2">{[kpi(t('fin.k.revenue'), d.total.revenue), kpi(t('fin.k.expenses'), d.total.expenses), kpi(t('fin.k.profit'), d.total.profit), kpi(t('fin.k.cash'), d.total.cash), kpi(t('fin.k.bank'), d.total.bank), kpi(t('fin.k.receivables'), d.total.receivables), kpi(t('fin.k.payables'), d.total.payables), kpi(t('fin.k.advances'), d.total.advances)]}</div>
        <h3>{t('fin.branchCompare')}</h3>
        <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.k.revenue')}</th><th scope="col">{t('fin.k.expenses')}</th><th scope="col">{t('fin.k.profit')}</th><th scope="col">{t('fin.k.cash')}</th><th scope="col">{t('fin.k.bank')}</th></tr></thead>
          <tbody>{d.branches.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.none')}</td></tr>}{d.branches.map((b) => <tr key={b.id}><th scope="row">{b.name}</th><td dir="ltr">{fmt(b.revenue)}</td><td dir="ltr">{fmt(b.expenses)}</td><td dir="ltr">{fmt(b.profit)}</td><td dir="ltr">{fmt(b.cash)}</td><td dir="ltr">{fmt(b.bank)}</td></tr>)}</tbody></table></div>
        <h3>{t('fin.trend')}</h3>
        <div className="stack" role="img" aria-label={t('fin.trend')}>{d.trend.map((x) => <div key={x.month} className="stack"><span className="small" dir="ltr">{x.month} · {fmt(x.profit)}</span>
          <div style={{ background: 'var(--ok, #2e7d32)', height: 8, width: `${(num(x.revenue) / max) * 100}%`, minWidth: 2, borderRadius: 4 }} title={`${t('fin.k.revenue')} ${fmt(x.revenue)}`} /><div style={{ background: 'var(--warn, #c77700)', height: 8, width: `${(num(x.expenses) / max) * 100}%`, minWidth: 2, borderRadius: 4 }} title={`${t('fin.k.expenses')} ${fmt(x.expenses)}`} /></div>)}</div>
        <p className="muted small">{t('fin.trendKey')}</p>
        <h3>{t('fin.needs')}</h3>
        {alerts.every(([k]) => !d.alerts[k]) ? <p className="okbox">{t('fin.nothingNeeds')}</p> : <ul>{alerts.filter(([k]) => d.alerts[k]).map(([k, tab, label]) => <li key={k}><button className="link" onClick={() => go(tab)}>{t(label as never, { n: d.alerts[k]! })}</button></li>)}</ul>}
      </>)}
    </section>
  );
}

interface RTable { title: string; currency: string; from?: string; to?: string; columns: string[]; numeric: boolean[]; rows: Array<{ cells: string[]; kind?: string }>; notes: string[]; ok: boolean }
const STATEMENTS = ['profit-loss', 'balance-sheet', 'cash-flow', 'daily-cash', 'bank-book', 'expenses', 'voucher-register', 'budget-vs-actual'] as const;
type Stmt = (typeof STATEMENTS)[number];
const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The statements and registers, for the company or one branch, each downloadable as a spreadsheet file. */
export function FinStatements() {
  const { t } = useT(); const { property, can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction(); const branches = useBranches();
  const bd = property!.businessDate;
  const [kind, setKind] = useState<Stmt>('profit-loss'); const [from, setFrom] = useState(first(bd)); const [to, setTo] = useState(bd); const [branch, setBranch] = useState(''); const [bankId, setBankId] = useState(''); const [banks, setBanks] = useState<Bank[]>([]); const [res, setRes] = useState<RTable | null>(null);
  const [bud, setBud] = useState({ account: '', branchId: '', month: bd.slice(0, 7), amount: '' }); const [accts, setAccts] = useState<Account[]>([]);
  useEffect(() => { void api<{ items: Bank[] }>('GET', '/v1/finance/banks').then((r) => { const ok = r.items.filter((b) => b.ledger); setBanks(ok); if (ok[0]) setBankId(ok[0].id); }); void api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setAccts(r.items.filter((a) => !a.isGroup && a.active && (a.type === 'EXPENSE' || a.type === 'REVENUE')))); }, []);
  const url = () => {
    const b = branch ? `&branchId=${branch}` : '';
    switch (kind) {
      case 'balance-sheet': return `/v1/finance/reports/balance-sheet?to=${to}${b}`; case 'daily-cash': return `/v1/finance/reports/daily-cash?date=${to}${b}`; case 'bank-book': return `/v1/finance/reports/bank-book?bankId=${bankId}&from=${from}&to=${to}`;
      case 'budget-vs-actual': return `/v1/finance/reports/budget-vs-actual?from=${from.slice(0, 7)}&to=${to.slice(0, 7)}${b}`; default: return `/v1/finance/reports/${kind}?from=${from}&to=${to}${b}`;
    }
  };
  const load = async () => { setRes(null); const r = await run(() => api<RTable>('GET', url())); if (r) setRes(r); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [kind, from, to, branch, bankId]);
  const download = () => { if (!res) return; const text = [res.columns, ...res.rows.map((r) => r.cells)].map((r) => r.map(csvCell).join(',')).join('\r\n'); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + text], { type: 'text/csv' })); a.download = `${kind}-${to}.csv`; a.click(); URL.revokeObjectURL(a.href); };
  const asAt = kind === 'balance-sheet' || kind === 'daily-cash';
  return (
    <section className="stack">
      <h2>{t('fin.statements')}</h2>
      <label>{t('fin.whichReport')}<select value={kind} onChange={(e) => setKind(e.target.value as Stmt)}>{STATEMENTS.map((s) => <option key={s} value={s}>{t(`fin.st2.${s}` as never)}</option>)}</select></label>
      <div className="grid2">{!asAt && <label>{t('fin.from')}<input type="date" value={from} onChange={(e) => setFrom(e.target.value)} dir="ltr" /></label>}<label>{asAt ? t('fin.asAt') : t('fin.to')}<input type="date" value={to} onChange={(e) => setTo(e.target.value)} dir="ltr" /></label></div>
      {kind === 'bank-book' ? <label>{t('fin.bankAcct')}<select value={bankId} onChange={(e) => setBankId(e.target.value)}>{banks.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label>
        : kind !== 'voucher-register' || true ? <label>{t('fin.branch')}<select value={branch} onChange={(e) => setBranch(e.target.value)}><option value="">{t('fin.allBranches')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label> : null}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!res ? <Spinner /> : (
        <div className="stack">
          <div className="row between"><h3>{res.title}</h3><button onClick={download}>{t('fin.download')}</button></div>
          {!res.ok && <p className="warnbox" role="alert">{t('fin.reportBad')}</p>}
          <div className="tablewrap"><table className="nighttable small"><thead><tr>{res.columns.map((c, i) => <th key={i} scope="col">{c}</th>)}</tr></thead>
            <tbody>{res.rows.length === 0 && <tr><td colSpan={res.columns.length} className="muted">{t('fin.none')}</td></tr>}{res.rows.map((r, i) => <tr key={i} style={r.kind === 'head' ? { fontWeight: 700 } : r.kind === 'total' ? { fontWeight: 700, borderTop: '2px solid currentColor' } : undefined}>{r.cells.map((c, j) => (j === 0 ? <th key={j} scope="row" style={{ fontWeight: 'inherit' }}>{c}</th> : <td key={j} dir={res.numeric[j] ? 'ltr' : undefined} style={res.numeric[j] ? { textAlign: 'end' } : undefined}>{res.numeric[j] && c && c !== '—' && c !== 'eliminated' ? fmt(c) : c}</td>))}</tr>)}</tbody></table></div>
          {res.notes.map((n, i) => <p key={i} className="muted small">{n}</p>)}
        </div>)}
      {kind === 'budget-vs-actual' && can('finance.setup') && (
        <form className="card inner stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => withStepUp(() => api('PUT', '/v1/finance/reports/budget', { branchId: bud.branchId || null, account: bud.account, month: bud.month, amount: bud.amount })))) { setBud({ ...bud, amount: '' }); void load(); } }}>
          <h3>{t('fin.setBudget')}</h3>
          <div className="grid2"><label>{t('fin.account')}<select value={bud.account} onChange={(e) => setBud({ ...bud, account: e.target.value })}><option value="">—</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label><label>{t('fin.branch')}<select value={bud.branchId} onChange={(e) => setBud({ ...bud, branchId: e.target.value })}><option value="">{t('fin.headOffice')}</option>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label></div>
          <div className="grid2"><label>{t('fin.month')}<input type="month" value={bud.month} onChange={(e) => setBud({ ...bud, month: e.target.value })} dir="ltr" /></label><label>{t('fin.amount')}<input inputMode="decimal" value={bud.amount} onChange={(e) => setBud({ ...bud, amount: clean(e.target.value) })} dir="ltr" /></label></div>
          <div className="actions"><button className="primary" type="submit" disabled={busy || !bud.account || !bud.amount}>{t('common.save')}</button></div>
        </form>)}
    </section>
  );
}

interface Supp { id: string; name: string; ntn: string | null; termsDays: number; status: string; owed: string; contactName: string | null; phone: string | null; iban: string | null; accountNumber: string | null }
interface SBill { id: string; branch: string; billNo: string; billDate: string; dueDate: string; total: string; paid: string; outstanding: string; available: string; status: string; overdueDays: number; voucherId: string; supplierId: string; supplier: string }
const SB_TONE: Record<string, 'neutral' | 'warn' | 'clean' | 'urgent'> = { OPEN: 'warn', PART_PAID: 'warn', PAID: 'clean', DRAFT: 'neutral', SUBMITTED: 'neutral', REJECTED: 'urgent', REVERSED: 'neutral' };

/** The people the hotels buy from, what is owed to each, and the bills and payments that make it up. */
export function FinSuppliers() {
  const { t } = useT(); const { can } = useAuth(); const { busy, problem, run } = useAction();
  const [rows, setRows] = useState<Supp[] | null>(null); const [open, setOpen] = useState<Supp | null>(null); const [f, setF] = useState({ name: '', ntn: '', terms: '30' });
  const load = () => api<{ items: Supp[] }>('GET', '/v1/finance/suppliers').then((r) => setRows(r.items));
  useEffect(() => { void load(); }, []);
  if (!rows) return <Spinner />;
  return (
    <section className="stack">
      <h2>{t('fin.suppliers')}</h2><p className="muted">{t('fin.suppliersHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.accountName')}</th><th scope="col">{t('fin.terms')}</th><th scope="col">{t('fin.owedNow')}</th><th scope="col">{t('fin.status')}</th></tr></thead>
        <tbody>{rows.length === 0 && <tr><td colSpan={4} className="muted">{t('fin.none')}</td></tr>}{rows.map((s) => <tr key={s.id}><th scope="row"><button className="link" onClick={() => setOpen(s)}>{s.name}</button></th><td>{t('fin.days', { n: s.termsDays })}</td><td dir="ltr">{fmt(s.owed)}</td><td>{s.status === 'ACTIVE' ? t('fin.active') : t('fin.off')}</td></tr>)}</tbody></table></div>
      {can('finance.prepare') && (
        <form className="card inner stack" onSubmit={async (e) => { e.preventDefault(); if (await run(() => api('POST', '/v1/finance/suppliers', { name: f.name, ...(f.ntn ? { ntn: f.ntn } : {}), paymentTermsDays: Number(f.terms) || 0 }))) { setF({ name: '', ntn: '', terms: '30' }); void load(); } }}>
          <h3>{t('fin.addSupplier')}</h3>
          <div className="grid2"><label>{t('fin.accountName')}<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={120} /></label><label>NTN<input value={f.ntn} onChange={(e) => setF({ ...f, ntn: e.target.value })} maxLength={30} dir="ltr" /></label></div>
          <label>{t('fin.terms')} ({t('fin.daysUnit')})<input inputMode="numeric" value={f.terms} onChange={(e) => setF({ ...f, terms: e.target.value.replace(/\D/g, '') })} dir="ltr" /></label>
          <div className="actions"><button className="primary" type="submit" disabled={busy || f.name.trim().length < 2}>{t('fin.addSupplier')}</button></div>
        </form>)}
      {open && <SupplierSheet supplier={open} onClose={() => { setOpen(null); void load(); }} />}
    </section>
  );
}

function SupplierSheet({ supplier, onClose }: { supplier: Supp; onClose: () => void }) {
  const { t } = useT(); const { property, can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [bills, setBills] = useState<SBill[] | null>(null); const [ledger, setLedger] = useState<{ rows: Array<{ date: string; voucherNo: string; narration: string; billed: string; paid: string; balance: string }>; closing: string } | null>(null); const [form, setForm] = useState<'bill' | 'pay' | null>(null); const [shown, setShown] = useState<{ iban: string | null; accountNumber: string | null } | null>(null);
  const bd = property!.businessDate;
  const load = async () => { setBills((await api<{ items: SBill[] }>('GET', `/v1/finance/supplier-bills?supplierId=${supplier.id}`)).items); setLedger(await api('GET', `/v1/finance/reports/supplier-ledger?supplierId=${supplier.id}&from=${bd.slice(0, 4)}-01-01&to=${bd}`)); };
  useEffect(() => { void load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);
  return (
    <Sheet title={supplier.name} onClose={onClose} wide>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <p className="small" dir="ltr">IBAN {shown?.iban ?? supplier.iban ?? '—'} · {t('fin.acctNo')} {shown?.accountNumber ?? supplier.accountNumber ?? '—'}</p>
      <div className="actions">
        {can('finance.prepare') && <button onClick={() => setForm('bill')}>{t('fin.newBill')}</button>}{can('finance.prepare') && <button className="primary" onClick={() => setForm('pay')}>{t('fin.paySupplier')}</button>}
        {can('finance.bank_details') && <button disabled={busy} onClick={async () => { const r = await run(() => withStepUp(() => api<{ iban: string | null; accountNumber: string | null }>('GET', `/v1/finance/suppliers/${supplier.id}/reveal`))); if (r) setShown(r); }}>{t('fin.reveal')}</button>}
      </div>
      <h3>{t('fin.bills')}</h3>
      {!bills ? <Spinner /> : <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.billNo')}</th><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.dueDate')}</th><th scope="col">{t('fin.total')}</th><th scope="col">{t('fin.outstanding')}</th><th scope="col">{t('fin.status')}</th></tr></thead>
        <tbody>{bills.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.none')}</td></tr>}{bills.map((b) => <tr key={b.id}><th scope="row">{b.billNo}</th><td>{b.branch}</td><td dir="ltr">{b.dueDate}{b.overdueDays > 0 && <Badge tone="urgent">{t('fin.days', { n: b.overdueDays })}</Badge>}</td><td dir="ltr">{fmt(b.total)}</td><td dir="ltr">{fmt(b.outstanding)}</td><td><Badge tone={SB_TONE[b.status] ?? 'neutral'}>{t(`fin.sb.${b.status}` as never)}</Badge></td></tr>)}</tbody></table></div>}
      <h3>{t('fin.supplierLedger')}</h3>
      {ledger && <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.date')}</th><th scope="col">{t('fin.no')}</th><th scope="col">{t('fin.narration')}</th><th scope="col">{t('fin.billed')}</th><th scope="col">{t('fin.paidCol')}</th><th scope="col">{t('fin.balance')}</th></tr></thead>
        <tbody>{ledger.rows.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.none')}</td></tr>}{ledger.rows.map((r, i) => <tr key={i}><td dir="ltr">{r.date}</td><td dir="ltr">{r.voucherNo}</td><td>{r.narration}</td><td dir="ltr">{r.billed === '0.00' ? '' : fmt(r.billed)}</td><td dir="ltr">{r.paid === '0.00' ? '' : fmt(r.paid)}</td><td dir="ltr">{fmt(r.balance)}</td></tr>)}</tbody></table></div>}
      {form === 'bill' && <BillForm supplier={supplier} onClose={() => setForm(null)} onSaved={() => { setForm(null); void load(); }} />}
      {form === 'pay' && bills && <PayForm supplier={supplier} bills={bills.filter((b) => Number(b.available) > 0)} onClose={() => setForm(null)} onSaved={() => { setForm(null); void load(); }} />}
    </Sheet>
  );
}

function BillForm({ supplier, onClose, onSaved }: { supplier: Supp; onClose: () => void; onSaved: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const branches = useBranches(); const [accts, setAccts] = useState<Account[]>([]);
  const bd = property!.businessDate; const [f, setF] = useState({ billNo: '', billDate: bd, dueDate: '', narration: '', branchId: property!.id }); const [lines, setLines] = useState([{ account: '', amount: '' }]);
  useEffect(() => { void api<{ items: Account[] }>('GET', '/v1/finance/accounts').then((r) => setAccts(r.items.filter((a) => !a.isGroup && a.active && (a.type === 'EXPENSE' || a.type === 'ASSET') && !a.control))); }, []);
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return (
    <Sheet title={`${t('fin.newBill')}: ${supplier.name}`} onClose={onClose}>
      <div className="grid2"><label>{t('fin.billNo')}<input value={f.billNo} onChange={(e) => setF({ ...f, billNo: e.target.value })} maxLength={60} dir="ltr" /></label><label>{t('fin.branch')}<select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label></div>
      <div className="grid2"><label>{t('fin.billDate')}<input type="date" value={f.billDate} onChange={(e) => setF({ ...f, billDate: e.target.value })} dir="ltr" /></label><label>{t('fin.dueDate')} ({t('common.optional')})<input type="date" value={f.dueDate} onChange={(e) => setF({ ...f, dueDate: e.target.value })} dir="ltr" /></label></div>
      <label>{t('fin.narration')}<input value={f.narration} onChange={(e) => setF({ ...f, narration: e.target.value })} maxLength={500} /></label>
      {lines.map((l, i) => <div key={i} className="grid2"><label>{t('fin.expenseFor')}<select value={l.account} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, account: e.target.value } : x)))}><option value="">—</option>{accts.map((a) => <option key={a.code} value={a.code}>{a.code} {a.name}</option>)}</select></label><label>{t('fin.amount')}<input inputMode="decimal" value={l.amount} onChange={(e) => setLines(lines.map((x, k) => (k === i ? { ...x, amount: clean(e.target.value) } : x)))} dir="ltr" /></label></div>)}
      <div className="row"><button type="button" onClick={() => setLines([...lines, { account: '', amount: '' }])}>{t('fin.addLine')}</button><strong dir="ltr">{t('fin.total')}: {total.toFixed(2)}</strong></div>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || !f.billNo || f.narration.trim().length < 3 || lines.some((l) => !l.account || !Number(l.amount))} onClick={async () => { if (await run(() => api('POST', '/v1/finance/supplier-bills', { supplierId: supplier.id, branchId: f.branchId, billNo: f.billNo, billDate: f.billDate, ...(f.dueDate ? { dueDate: f.dueDate } : {}), narration: f.narration, lines: lines.map((l) => ({ account: l.account, amount: l.amount })) }))) onSaved(); }}>{t('fin.saveDraft')}</button></div>
    </Sheet>
  );
}

function PayForm({ supplier, bills, onClose, onSaved }: { supplier: Supp; bills: SBill[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useT(); const { property } = useAuth(); const { busy, problem, run } = useAction(); const branches = useBranches(); const [banks, setBanks] = useState<Bank[]>([]);
  const [sel, setSel] = useState<Record<string, string>>({}); const [f, setF] = useState({ date: property!.businessDate, reference: '', branchId: branches[0]?.id ?? '', money: 'CASH' });
  useEffect(() => { void api<{ items: Bank[] }>('GET', '/v1/finance/banks').then((r) => setBanks(r.items.filter((b) => b.ledger))); }, []);
  const total = Object.values(sel).reduce((s, v) => s + (Number(v) || 0), 0);
  const ref = () => { const [k, id] = f.money.split(':'); return k === 'BANK' ? { kind: 'BANK', bankId: id } : { kind: k }; };
  return (
    <Sheet title={`${t('fin.paySupplier')}: ${supplier.name}`} onClose={onClose} wide>
      <p className="muted small">{t('fin.payHelp')}</p>
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col" /><th scope="col">{t('fin.billNo')}</th><th scope="col">{t('fin.branch')}</th><th scope="col">{t('fin.dueDate')}</th><th scope="col">{t('fin.outstanding')}</th><th scope="col">{t('fin.payNow')}</th></tr></thead>
        <tbody>{bills.length === 0 && <tr><td colSpan={6} className="muted">{t('fin.nothingToPay')}</td></tr>}{bills.map((b) => <tr key={b.id}><td><input type="checkbox" aria-label={b.billNo} checked={b.id in sel} onChange={(e) => { const n = { ...sel }; if (e.target.checked) n[b.id] = b.available; else delete n[b.id]; setSel(n); }} /></td><th scope="row">{b.billNo}</th><td>{b.branch}</td><td dir="ltr">{b.dueDate}</td><td dir="ltr">{fmt(b.available)}</td><td>{b.id in sel && <input aria-label={`${b.billNo}: ${t('fin.payNow')}`} inputMode="decimal" value={sel[b.id]} onChange={(e) => setSel({ ...sel, [b.id]: clean(e.target.value) })} dir="ltr" />}</td></tr>)}</tbody></table></div>
      <div className="grid2"><label>{t('fin.date')}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} dir="ltr" /></label><label>{t('fin.branch')}<select value={f.branchId} onChange={(e) => setF({ ...f, branchId: e.target.value })}>{branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></label></div>
      <div className="grid2"><label>{t('fin.paidFrom')}<select value={f.money} onChange={(e) => setF({ ...f, money: e.target.value })}><option value="CASH">{t('fin.cashDrawer')}</option><option value="PETTY">{t('fin.petty')}</option>{banks.map((b) => <option key={b.id} value={`BANK:${b.id}`}>{b.name}</option>)}</select></label><label>{t('fin.chequeRef')}<input value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} maxLength={120} dir="ltr" /></label></div>
      <p className="muted small" dir="ltr">{t('fin.total')}: {total.toFixed(2)}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      <div className="actions"><button onClick={onClose}>{t('common.cancel')}</button><button className="primary" disabled={busy || total <= 0 || !f.branchId} onClick={async () => { if (await run(() => api('POST', '/v1/finance/supplier-payments', { supplierId: supplier.id, branchId: f.branchId, date: f.date, ...(f.reference ? { reference: f.reference } : {}), money: ref(), allocations: Object.entries(sel).map(([billId, amount]) => ({ billId, amount })) }))) onSaved(); }}>{t('fin.saveDraft')}</button></div>
    </Sheet>
  );
}

interface AgeRow { supplierId: string; supplier: string; current: string; d30: string; d60: string; d90: string; over90: string; total: string }
/** What is owed to suppliers, by how late it is. */
export function FinPayables() {
  const { t } = useT(); const { property } = useAuth(); const { problem, run } = useAction(); const [asAt, setAsAt] = useState(property!.businessDate); const [d, setD] = useState<{ rows: AgeRow[]; totals: Omit<AgeRow, 'supplierId' | 'supplier'> } | null>(null);
  useEffect(() => { setD(null); void run(() => api<{ rows: AgeRow[]; totals: Omit<AgeRow, 'supplierId' | 'supplier'> }>('GET', `/v1/finance/reports/payables-ageing?asAt=${asAt}`)).then((r) => r && setD(r)); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [asAt]);
  return (
    <section className="stack">
      <h2>{t('fin.payables')}</h2><p className="muted">{t('fin.payablesHelp')}</p>
      <label>{t('fin.asAt')}<input type="date" value={asAt} onChange={(e) => setAsAt(e.target.value)} dir="ltr" /></label>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {!d ? <Spinner /> : <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.suppliers')}</th><th scope="col">{t('fin.notDue')}</th><th scope="col">1–30</th><th scope="col">31–60</th><th scope="col">61–90</th><th scope="col">90+</th><th scope="col">{t('fin.total')}</th></tr></thead>
        <tbody>{d.rows.length === 0 && <tr><td colSpan={7} className="muted">{t('fin.none')}</td></tr>}{d.rows.map((r) => <tr key={r.supplierId}><th scope="row">{r.supplier}</th>{[r.current, r.d30, r.d60, r.d90, r.over90, r.total].map((v, i) => <td key={i} dir="ltr">{v === '0.00' ? '' : fmt(v)}</td>)}</tr>)}</tbody>
        <tfoot><tr><th scope="row">{t('fin.total')}</th>{[d.totals.current, d.totals.d30, d.totals.d60, d.totals.d90, d.totals.over90, d.totals.total].map((v, i) => <td key={i} dir="ltr">{fmt(v)}</td>)}</tr></tfoot></table></div>}
    </section>
  );
}

interface FyRow { start: string; end: string; current: boolean; monthsClosed: number; months: number; status: 'OPEN' | 'PENDING' | 'CLOSED'; voucherId: string | null }
interface FyPreview { start: string; end: string; blockers: Array<{ code: string; message: string }>; canClose: boolean; result: string; byBranch: Array<{ branch: string; result: string }> }

/** The financial year: when it starts, and closing it once every month is closed. */
function YearEnd() {
  const { t } = useT(); const { can } = useAuth(); const withStepUp = useStepUp(); const { busy, problem, run } = useAction();
  const [data, setData] = useState<{ startMonth: number; items: FyRow[] } | null>(null); const [pv, setPv] = useState<FyPreview | null>(null); const [made, setMade] = useState(false); const [hidden, setHidden] = useState(false);
  const load = () => api<{ startMonth: number; items: FyRow[] }>('GET', '/v1/finance/year-end').then(setData).catch(() => setHidden(true));     // a branch role has no say over the year
  useEffect(() => { void load(); }, []);
  if (hidden) return null;
  if (!data) return <Spinner />;
  const monthName = (m: number) => new Date(Date.UTC(2000, m - 1, 1)).toLocaleDateString('en-GB', { month: 'long', timeZone: 'UTC' });
  return (
    <div className="card inner stack">
      <h3>{t('fin.fy')}</h3><p className="muted small">{t('fin.fyHelp')}</p>
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {made && <p className="okbox" role="status">{t('fin.fyMade')}</p>}
      {can('finance.setup') && <label>{t('fin.fyStart')}<select value={data.startMonth} onChange={async (e) => { if (await run(() => withStepUp(() => api('PUT', '/v1/finance/settings', { fiscalYearStartMonth: Number(e.target.value) })))) void load(); }}>{Array.from({ length: 12 }, (_, i) => i + 1).map((m) => <option key={m} value={m}>{monthName(m)}</option>)}</select></label>}
      <div className="tablewrap"><table className="nighttable small"><thead><tr><th scope="col">{t('fin.fy')}</th><th scope="col">{t('fin.monthsClosed')}</th><th scope="col">{t('fin.status')}</th><th scope="col"><span className="sr-only">{t('fin.actions')}</span></th></tr></thead>
        <tbody>{data.items.map((y) => <tr key={y.end}><th scope="row" dir="ltr">{y.start} → {y.end}</th><td>{y.monthsClosed} / {y.months}</td><td><Badge tone={y.status === 'CLOSED' ? 'clean' : y.status === 'PENDING' ? 'warn' : 'neutral'}>{t(`fin.fys.${y.status}` as never)}</Badge></td>
          <td>{can('finance.period') && y.status === 'OPEN' && !y.current && <button disabled={busy} onClick={async () => { setMade(false); const r = await run(() => api<FyPreview>('GET', `/v1/finance/year-end/preview?end=${y.end}`)); if (r) setPv(r); }}>{t('fin.closeYear')}</button>}</td></tr>)}</tbody></table></div>
      {pv && (
        <Sheet title={`${t('fin.closeYear')}: ${pv.start} → ${pv.end}`} onClose={() => setPv(null)}>
          {pv.blockers.length > 0 && <ul>{pv.blockers.map((b) => <li key={b.code} className="warnbox">{b.message}</li>)}</ul>}
          <p>{t('fin.fyResult')}: <strong dir="ltr">{fmt(pv.result)}</strong></p>
          <ul>{pv.byBranch.map((b) => <li key={b.branch}>{b.branch}: <span dir="ltr">{fmt(b.result)}</span></li>)}</ul>
          <p className="muted small">{t('fin.fyWhat')}</p>
          <ErrorLine code={problem?.code} detail={problem?.detail} />
          <div className="actions"><button onClick={() => setPv(null)}>{t('common.cancel')}</button><button className="primary" disabled={busy || !pv.canClose} onClick={async () => { if (await run(() => withStepUp(() => api('POST', '/v1/finance/year-end/close', { end: pv.end })))) { setPv(null); setMade(true); void load(); } }}>{t('fin.prepareClose')}</button></div>
        </Sheet>)}
    </div>
  );
}
