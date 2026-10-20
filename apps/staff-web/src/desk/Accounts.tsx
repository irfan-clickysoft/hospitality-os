import { useRef, useState } from 'react';
import { api } from '../api/client.js';
import { useT } from '../i18n/index.js';
import type { Key } from '../i18n/en.js';
import { useAction } from '../lib/action.js';
import { money } from '../lib/format.js';
import { groupIban, ibanValid, swiftValid, tidyIban } from '../lib/iban.js';
import { useStepUp } from '../lib/stepup.js';
import { useAuth, useLive } from '../state.js';
import { Field } from '../ui/ds.js';
import { Badge, Empty, ErrorLine, Sheet, Spinner } from '../ui/kit.js';
import type { Amount } from './types.js';

interface Account { branch: string | null; branchCode: string | null; branchAddress: string | null; iban: string | null; accountNumber: string | null; swiftCode: string | null; hasQr: boolean; id: string; propertyId: string | null; kind: string; name: string; bankName: string | null; accountTitle: string | null; last4: string | null; ownerType: string; ownerName: string | null; flagged: boolean; status: string; note: string | null; version: number; count: number; in: Amount; out: Amount; net: Amount }
interface Summary { from: string; to: string; items: Account[]; totalIn: Amount; nonCompany: { accounts: number; in: Amount; net: Amount }; unassigned: { count: number; in: Amount; out: Amount } }
const KINDS = ['BANK', 'CARD_CLEARING', 'WALLET', 'GATEWAY'];
const zero = (a: Amount) => /^-?0+(\.0+)?$/.test(a.amount);

/** Where money actually lands, and how much went into each account — with accounts that are not the company’s shown in red, never hidden. */
export function Accounts() {
  const { t } = useT();
  const { can } = useAuth();
  const [days, setDays] = useState(30);
  const first = useLive<Summary>('/v1/payment-accounts/summary', 120_000);
  const to = first.data?.to;
  const ranged = useLive<Summary>(to && days !== 30 ? `/v1/payment-accounts/summary?from=${new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)}&to=${to}` : null, 120_000);
  const s = days === 30 ? first.data : ranged.data;
  const [edit, setEdit] = useState<Account | 'new' | null>(null);
  if (!s) return <Spinner />;
  const reload = () => { first.reload(); ranged.reload(); };
  return (
    <section className="stack">
      <h2>{t('nav.accounts')}</h2>
      <div className="chips">{[7, 30, 90].map((n) => <button key={n} className={`chip${days === n ? ' on' : ''}`} onClick={() => setDays(n)}>{t('mg.days', { n })}</button>)}</div>
      <p className="muted small">{s.from} → {s.to} · {t('pa.verifiedOnly')}</p>
      <div className="card stack small">
        <div className="row between"><strong>{t('pa.totalIn')}</strong><strong>{money(s.totalIn)}</strong></div>
        {s.nonCompany.accounts > 0 && <div className="row between"><span className="error">{t('pa.nonCompany')}</span><strong className="error">{money(s.nonCompany.in)}</strong></div>}
        {s.unassigned.count > 0 && <div className="row between"><span className="warnbox">{t('pa.unassigned', { n: s.unassigned.count })}</span><strong>{money(s.unassigned.in)}</strong></div>}
      </div>
      {can('paymentaccount.manage') && <div className="actions"><button className="primary" onClick={() => setEdit('new')}>{t('pa.new')}</button></div>}
      {s.items.length === 0 ? <Empty text={t('pa.none')} /> : (
        <ul className="plain rows">{s.items.map((a) => (
          <li key={a.id}><button className="row-card" onClick={() => setEdit(a)}>
            <span className="rc-main"><strong>{a.name}{a.last4 ? ` ····${a.last4}` : ''}</strong><span className="muted small">{t(`pa.k.${a.kind}` as Key)}{a.bankName ? ` · ${a.bankName}` : ''} · {a.ownerType === 'COMPANY' ? t('pa.owner.COMPANY') : `${t(`pa.owner.${a.ownerType}` as Key)}: ${a.ownerName}`}</span></span>
            <span className="rc-side"><strong className={a.flagged ? 'error' : ''}>{money(a.in)}</strong>{!zero(a.out) && <span className="muted small">− {money(a.out)}</span>}{a.flagged && <Badge tone="dirty">{t('pa.notCompany')}</Badge>}{a.status === 'CLOSED' && <Badge tone="neutral">{t('pa.closed')}</Badge>}</span>
          </button></li>))}</ul>)}
      {edit && <AccountSheet account={edit === 'new' ? null : edit} onDone={() => { setEdit(null); reload(); }} onClose={() => setEdit(null)} />}
    </section>
  );
}

function AccountSheet({ account, onDone, onClose }: { account: Account | null; onDone: () => void; onClose: () => void }) {
  const { t } = useT();
  const { can } = useAuth();
  const withStepUp = useStepUp();
  const manage = can('paymentaccount.manage');
  const [f, setF] = useState({ name: account?.name ?? '', kind: account?.kind ?? 'BANK', bankName: account?.bankName ?? '', accountTitle: account?.accountTitle ?? '', branch: account?.branch ?? '', branchCode: account?.branchCode ?? '', branchAddress: account?.branchAddress ?? '', iban: account?.iban ? groupIban(account.iban) : '', accountNumber: account?.accountNumber ?? '', swiftCode: account?.swiftCode ?? '', ownerType: account?.ownerType ?? 'COMPANY', ownerName: account?.ownerName ?? '', note: account?.note ?? '', reason: '' });
  const { busy, problem, run } = useAction();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const body = () => ({ name: f.name.trim(), kind: f.kind, bankName: f.bankName.trim() || null, accountTitle: f.accountTitle.trim() || null, branch: f.branch.trim() || null, branchCode: f.branchCode.trim() || null, branchAddress: f.branchAddress.trim() || null, iban: f.iban.trim() ? tidyIban(f.iban) : null, accountNumber: f.accountNumber.trim() || null, swiftCode: f.swiftCode.trim() ? f.swiftCode.replace(/\s+/g, '').toUpperCase() : null, ownerType: f.ownerType, ownerName: f.ownerType === 'COMPANY' ? null : f.ownerName.trim(), note: f.note.trim() || null });
  const save = async () => { if (await run(() => withStepUp(() => account ? api('PATCH', `/v1/payment-accounts/${account.id}`, { ...body(), version: account.version }) : api('POST', '/v1/payment-accounts', body())))) onDone(); };
  const close = async () => { if (await run(() => withStepUp(() => api('POST', `/v1/payment-accounts/${account!.id}/close`, { version: account!.version, reason: f.reason.trim() })))) onDone(); };
  const valid = f.name.trim().length >= 2 && (f.ownerType === 'COMPANY' || f.ownerName.trim().length >= 2) && (!f.iban.trim() || ibanValid(f.iban)) && (!f.swiftCode.trim() || swiftValid(f.swiftCode));
  return (
    <Sheet title={account?.name ?? t('pa.new')} onClose={onClose}>
      <fieldset disabled={!manage} className="stack" style={{ border: 0, padding: 0 }}>
        <label>{t('cmp.name')}<input value={f.name} onChange={set('name')} /></label>
        <label>{t('pa.kind')}<select value={f.kind} onChange={set('kind')}>{KINDS.map((k) => <option key={k} value={k}>{t(`pa.k.${k}` as Key)}</option>)}</select></label>
        <div className="grid2"><label>{t('pa.bankName')}<input value={f.bankName} onChange={set('bankName')} /></label><label>{t('pa.title')}<input value={f.accountTitle} onChange={set('accountTitle')} /></label></div>
        {f.kind === 'BANK' && (<>
          <div className="grid2"><label>{t('pa.branch')}<input value={f.branch} onChange={set('branch')} /></label><label>{t('pa.branchCode')}<input value={f.branchCode} onChange={set('branchCode')} dir="ltr" /></label></div>
          <label>{t('pa.branchAddress')}<input value={f.branchAddress} onChange={set('branchAddress')} /></label>
          <Field label={t('pa.iban')} hint={t('pa.ibanHint')} error={f.iban.trim() && !ibanValid(f.iban) ? t('pa.ibanBad') : undefined}>{(p) => <input {...p} value={f.iban} dir="ltr" onChange={set('iban')} onBlur={() => f.iban.trim() && ibanValid(f.iban) && setF({ ...f, iban: groupIban(f.iban) })} placeholder="PK36 SCBL 0000 0011 2345 6702" />}</Field>
          <div className="grid2"><label>{t('pa.accountNumber')}<input value={f.accountNumber} onChange={set('accountNumber')} dir="ltr" /></label>
            <Field label={t('pa.swift')} error={f.swiftCode.trim() && !swiftValid(f.swiftCode) ? t('pa.swiftBad') : undefined}>{(p) => <input {...p} value={f.swiftCode} dir="ltr" onChange={set('swiftCode')} placeholder="SCBLPKKA" />}</Field></div>
        </>)}
        <label>{t('pa.ownedBy')}<select value={f.ownerType} onChange={set('ownerType')}>{['COMPANY', 'PERSONAL', 'OTHER'].map((o) => <option key={o} value={o}>{t(`pa.owner.${o}` as Key)}</option>)}</select></label>
        {f.ownerType !== 'COMPANY' && <><label>{t('pa.ownerName')}<input value={f.ownerName} onChange={set('ownerName')} /></label><p className="warnbox">{t('pa.flagNote', { owner: f.ownerName })}</p></>}
        <label>{t('pa.remarks')}<input value={f.note} onChange={set('note')} /></label>
      </fieldset>
      {account && f.kind === 'BANK' && <QrCode account={account} manage={manage} onChanged={onDone} />}
      {!account && f.kind === 'BANK' && <p className="muted small">{t('pa.qrAfterSave')}</p>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
      {manage && <div className="actions"><button className="primary" disabled={busy || !valid} onClick={save}>{t('common.save')}</button></div>}
      {manage && account && account.status === 'ACTIVE' && <div className="row"><input value={f.reason} placeholder={t('common.reason')} onChange={set('reason')} /><button disabled={busy || f.reason.trim().length < 3} onClick={close}>{t('pa.close')}</button></div>}
    </Sheet>
  );
}

/** The account's QR code, shown to staff so a guest can scan it to pay. */
function QrCode({ account, manage, onChanged }: { account: Account; manage: boolean; onChanged: () => void }) {
  const { t } = useT();
  const withStepUp = useStepUp();
  const { busy, problem, run } = useAction();
  const pick = useRef<HTMLInputElement>(null);
  const [stamp, setStamp] = useState(0);
  const upload = async (files: FileList | null) => { const file = files?.[0]; if (!file) return; const fd = new FormData(); fd.append('file', file); if (await run(() => withStepUp(() => api('POST', `/v1/payment-accounts/${account.id}/qr`, fd)))) { setStamp(Date.now()); onChanged(); } };
  const remove = async () => { if (await run(() => withStepUp(() => api('DELETE', `/v1/payment-accounts/${account.id}/qr`)))) { setStamp(Date.now()); onChanged(); } };
  return (
    <fieldset className="guestcard"><legend>{t('pa.qr')}</legend>
      {account.hasQr ? <img src={`/v1/payment-accounts/${account.id}/qr?v=${stamp}`} alt={`${t('pa.qr')} — ${account.name}`} style={{ maxWidth: 220, width: '100%', background: '#fff', padding: 8, borderRadius: 8 }} /> : <p className="muted small">{t('pa.qrNone')}</p>}
      {manage && <div className="actions">
        <input ref={pick} type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={(e) => { void upload(e.target.files); e.target.value = ''; }} />
        <button type="button" disabled={busy} onClick={() => pick.current?.click()}>{account.hasQr ? t('pa.qrReplace') : t('pa.qrAdd')}</button>
        {account.hasQr && <button type="button" disabled={busy} onClick={() => void remove()}>{t('ci.remove')}</button>}
      </div>}
      <ErrorLine code={problem?.code} detail={problem?.detail} />
    </fieldset>
  );
}
