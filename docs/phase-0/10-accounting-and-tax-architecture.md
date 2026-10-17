# 10 — Integrated Accounting, Payment & Tax Architecture (Revision 2)

> Extends `03` §R–T and `09` §4.7 / §4.15. Where they conflict, this file wins.
> **Legal status:** every rate, threshold, eligibility rule and legal reference below is an **illustrative configuration example supplied by the product owner, not verified law**. Nothing in this file asserts what Pakistani, FBR or SRB law requires. All tax content must be confirmed by a qualified Sindh/Islamabad tax practitioner before go-live (see §9).

## 1. Principle: one integrated, complete ledger

Sunset BnB needs *one* accounting system with several payment methods, several tax codes and several reporting views — **not two sets of books**.

- Every charge, receipt, refund and adjustment is recorded in the single immutable posting ledger (`03` §R), whatever the payment method, amount or tax treatment.
- Cash is a **payment method**, not a tax status. A cash receipt for a taxable service is taxable; the ledger records the tender, the tax code applied and the resulting liability.
- **There is no "non-disclosed", "off-ledger" or "no-tax-record" mode**, and no way to take a transaction out of the ledger, suppress it from tax reports, or issue a document outside the audit trail. Owners may restrict *who within the business* sees which report, but the ledger and the tax reports are always complete. This is a permanent product boundary, not a configuration option, and it is also what protects the owner from staff skimming and gives them defensible records in an audit.
- Where a transaction is *genuinely* outside the tax base (a lawful exemption, a refundable deposit, a pass-through), the system records it under the proper tax code with its legal basis and evidence — it is still recorded.

## 2. Three layers

### Layer A — Payments (how money was received)
`payment_account` registry, per legal entity: `CASH_DRAWER`, `BANK` (company or other-owner account — *the owner of the account is recorded and non-company accounts are flagged in finance and audit reports*), `CARD_CLEARING`, `WALLET` (JazzCash/Easypaisa), `GATEWAY` (PayFast), `AR_CORPORATE`, `GUEST_ADVANCE` (liability), `OTA_RECEIVABLE`.

| Tender | Posts to | Notes |
|---|---|---|
| Cash | Cash in hand (drawer, via cashier session) | Counted at shift close; variance reviewed |
| Bank transfer | Bank account | Proof attached and verified (`03` §S.3) |
| Card / POS slip | Card clearing → bank on settlement | RRN/last-4/approval code |
| Wallet / QR | Wallet clearing → bank on settlement | |
| PayFast / online | Gateway clearing → bank on settlement | Hotel's own merchant account |
| Corporate credit | Accounts receivable | Billed on AR invoice |
| Advance deposit | Guest advance (liability) | Applied/forfeited/refunded by policy |
Every payment carries `tender_type`, `payment_account_id`, `cashier_session_id` (cash) and `provider_ref` where relevant, so management can see revenue received by channel.

### Layer B — Tax engine (what tax applies)
Tax treatment is a function of the **nature of the supply**, the **jurisdiction and date**, and — *only where the configured rule makes the rate depend on it* — the **payment channel**.

```
TaxDetermination(input) → { tax_code, rate_bp, basis, input_tax_treatment, legal_ref_id, evidence_required[] }
input = { property→jurisdiction, effective date, line txn_code / service class,
          package context (component allocation), customer attributes (exemption certificate),
          tender channel (if rule says so), amount, inclusive/exclusive }
```
`tax_code` registry (configuration, versioned, effective-dated):

| Field | Meaning |
|---|---|
| `code` | e.g. `TAX-ROOM-STD`, `TAX-FNB-CASH`, `TAX-FNB-DIGITAL`, `TAX-LAUNDRY`, `TAX-EXEMPT`, `TAX-OUT-OF-SCOPE`, `TAX-DEPOSIT` (examples from the owner's brief; names are configurable) |
| `jurisdiction` | Sindh, Islamabad (ICT), Punjab, … |
| `legal_basis` | Free-text citation + attachment, entered/approved by the tax advisor |
| `rate` | Percentage or fixed; effective-from/to |
| `eligibility_conditions` | Declarative conditions (service class, tender channel, thresholds, registration status) |
| `input_tax_treatment` | `RECOVERABLE`, `NOT_RECOVERABLE`, `N/A` |
| `rounding` | Line vs invoice level |
| `requires_evidence` | e.g. exemption certificate, proof of digital payment |
| `status` | `DRAFT → ADVISOR_APPROVED → ACTIVE → SUPERSEDED` |

**Rule: no tax rate or eligibility rule is hard-coded.** Changing a tax code requires `tax.configure`, an advisor-approval flag, a reason, and creates a new version; historical postings keep the version they used.

#### The payment-channel problem
If a rate depends on how the bill is paid (e.g. a restaurant-service rate that differs for cash vs qualifying digital payment), the correct rate is not known when the charge is posted to a room folio — only when the bill is settled, possibly by **split tender**. Design:
- Each tax code declares a **`determination_point`**: `ON_POSTING`, `ON_SETTLEMENT`, or `ON_INVOICE`.
- For `ON_SETTLEMENT` codes the posting carries a provisional rate; the tax amount is **finalised at invoice issuance** from the tenders actually applied (allocation of each tender across lines is a defined rule, e.g. proportional or first-applied — configurable and shown on the invoice). Changing a tender after issuance requires a **credit note + re-issue**, never an edit.
- The lower-rate path applies **only to lines whose service class meets the code's eligibility conditions**; a guest paying a hotel bill by card never makes room charges eligible for a restaurant rate. Eligibility is evaluated per line, not per bill.
- Whether this payment-dependent rule exists, its conditions and any invoicing obligations are advisor-confirmed inputs (§9).

### Layer C — Ledgers (unified general ledger)
Per legal entity, a seeded chart-of-accounts template (editable) with mapping tables; postings are mapped, not hand-journalled.

| Mapping | Example |
|---|---|
| `txn_code → revenue account` | 4001 Room · 4002 Food · 4003 Beverage · 4004 Laundry · 4005 Other guest services · 4006 Meeting-room |
| `tender / payment_account → asset account` | 1001 Cash in hand · 1002 Bank · 1003 Card clearing · 1004 Wallet/gateway clearing · 1100 Accounts receivable (corporate) · 1110 OTA receivable |
| `tax_code → liability account` | 2101 Output tax – accommodation · 2102 Output tax – restaurant services · 2103 Input tax recoverable (where permitted) |
| `deposit → liability` | 2200 Guest advances/deposits |
| Contra / adjustments | Discounts, comps, write-offs, loyalty redemptions, cancellation-fee income |
Journal export (CSV; later QuickBooks/Xero/SAP) is generated from postings via these mappings; posting periods lock at night audit/month-end.

## 3. Invoicing and quoting
- Quotes show amounts **excluding tax**, then taxes by tax code, then the total (`09` §4.7).
- Invoices show, per line: description, service class, tax code, rate, taxable value, tax; totals by tax code; tender summary; legal-entity registration details per jurisdiction pack. Gapless numbering per entity/series (`03` §R.5).
- Exempt and out-of-scope lines are shown as such with the exemption reason code; exemption certificates are stored and referenced.

## 4. Pricing structure and component allocation (Model A vs Model B)
Separately priced components can legitimately change tax outcomes; **relabelling room rent as other services cannot**. The system supports component pricing with guardrails:
- A **component allocation** (`rate_component_allocation`) splits a package price into room, breakfast, etc. using **configured standalone prices** (the component's own published/menu price, also offered separately where the advisor says that matters), not arbitrary percentages.
- Each allocation is **versioned, approved by an authorised role with advisor-confirmed status, and printed on the invoice**; it records basis (e.g. standalone menu price ratio), effective dates and who approved it.
- **Evidence of supply:** F&B components link to actual service records (kitchen/room-service orders or breakfast-served log) where the advisor requires proof the service was supplied.
- **Compulsory vs optional components:** a flag marks whether a component can be declined; the advisor may require inseparable components to be taxed with the room. The tax engine honours this flag per jurisdiction.
- **Impact simulator (management dashboard):** side-by-side calculation of the same stay under Model A (all-in) and Model B (components) using the active tax codes — the illustrative case in the brief (Rs 15,000 stay → Rs 2,250 tax all-in vs Rs 2,005 split; difference Rs 245) is a **seed test fixture**, labelled *illustrative, not advice*, and shows the assumptions and each line's eligibility status. It is a planning tool; invoices always use the approved allocation.
- Reports flag packages whose allocation has changed, is outside an advisor-approved range, or lacks supporting service records.

## 5. Deposits and advances
Refundable security deposits and advance booking payments are recorded as **liabilities** (`GUEST_ADVANCE`), not revenue, at receipt. Whether tax applies at receipt of an advance, on application to the stay, or on forfeiture is a `tax_code` setting (`determination_point`) confirmed by the advisor. Forfeiture and application are explicit postings with reason codes.

## 6. Reports and dashboards
All are generated from the same ledger.
- **Receipts by tender / payment account** (cash vs bank vs card vs wallet vs gateway), by day, shift, cashier, property.
- **Revenue by category** (room, food, beverage, laundry, services) and by rate plan/source.
- **Tax liability by stream:** taxable value and tax by tax code, jurisdiction and period, with drill-down to invoices; **exempt / out-of-scope register** with reasons and evidence; input-tax register.
- **Return-preparation worksheet** per jurisdiction in the format the advisor specifies (monthly/period summary); locked after filing flag.
- **Deposit/advance ledger** and aging; AR aging (corporate); OTA receivables.
- **Reconciliations:** cash drawer vs counted; bank vs bank-transfer postings; gateway/card settlements vs clearing; AR vs invoices; ledger vs folios (invariant checker).
- **Management dashboard:** revenue and tax liability per revenue stream, effective tax rate, cash share of receipts, non-company-account receipts, variance trends. Report *visibility* is controlled by role; report *completeness* is not configurable.

## 7. Controls
- Posting immutability, business-date locking, reversal-only corrections (`03`).
- `tax.configure`, `tax.approve`, `allocation.approve`, `exemption.apply` are separate permissions; maker–checker on tax-code and allocation changes; all audited with before/after.
- Alerts: tax-code changed, allocation changed, exemption used above threshold, receipts into non-company accounts, large cash share changes, manual tax overrides (which require reason and approval and are reported).
- Manual tax override is allowed only through a defined exemption/override code with evidence; it can never remove the transaction from the ledger.
- Tenant data export for auditors/advisors (read-only, time-boxed access role: `Tax Advisor`).

## 8. Data-model additions
`payment_account (owner_type, owner_name, legal_entity_id, flagged)`, `tax_jurisdiction`, `tax_code`, `tax_code_version`, `tax_determination_rule`, `tax_exemption_certificate`, `exemption_application`, `service_class`, `ledger_account`, `account_mapping`, `gl_period`, `journal_export`, `rate_component_allocation (basis, approved_by, advisor_ref)`, `service_supply_evidence`, `tax_period_summary`, `tax_override_log`.
Release placement: tax-code registry, payment accounts, ledger mappings, component allocation with guardrails and the core reports are **R1** (they are the foundation of invoicing); the impact simulator and return-prep worksheet formats are **R1b**; ERP connectors are R3.

## 9. Advisor verification checklist (before any rule is activated)
1. Current Sindh (SRB) and Islamabad (ICT) tax treatment for: accommodation, restaurant/food and beverage, laundry, meeting rooms, transport, other services — rates, input-tax treatment, registration status.
2. Whether and how rates depend on payment channel (cash vs digital) for any service, the exact eligibility conditions, and any invoicing/POS-integration obligations.
3. Treatment of bundled packages (room + breakfast): allowed separation, required evidence, compulsory vs optional components.
4. Treatment of advance payments, refundable deposits, forfeited deposits, cancellation/no-show fees, OTA-collected amounts, withholding taxes by corporate customers.
5. Invoice content, numbering and record-keeping requirements; retention periods.
6. Return formats and filing calendar.
7. Any amendments effective during 2026 (the brief mentions July 2026 changes) and their transitional rules.
Outputs become the approved `tax_code` versions and golden test fixtures; the engine ships empty of rates until then.

## 10. Explicitly not provided
Any mode, role, setting, report filter or hidden ledger that omits, hides or excludes transactions from the books or the tax reports; any tool to produce receipts that are not recorded; any "non-tax" payment channel that bypasses posting. The product records everything and calculates tax per the advisor-approved configuration; the business and its advisor remain responsible for its tax position.
