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
