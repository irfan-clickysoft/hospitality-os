# 09 — Stakeholder Decisions & Scope Changes (Revision 1)

**Product owner:** Irfan A Rehman · **Pilot customer:** Sunset BnB (Boulevard, Creek — Karachi; Ramna — Islamabad)
**Supersedes** wherever it conflicts: `01` §F tiers, `07` §AN–AR and §AV, `08` D-11/D-12/D-16. Those files carry short amendment notes pointing here.
**Status:** DRAFT — pending stakeholder confirmation of the items in §10.

> Sunset's CSR initiatives are simply tenant-configurable content in the guest app (see §4.2).

---

## 1. Pilot profile (Sunset BnB)

| Item | Detail |
|---|---|
| Properties | **Boulevard** (Karachi): 9 rooms + 1 conference/meeting room (sold **hourly or full-day**) · **Creek** (Karachi): 10 rooms · **Ramna** (Islamabad): 8 rooms — **27 rooms in total** |
| Tenancy | One tenant (Sunset), three properties, **two tax jurisdictions** (Sindh, Islamabad) ⇒ tax configuration per property is mandatory |
| Guests | Mostly **corporate** across all three properties; OTA bookings (notably Booking.com, with frequent unpaid cancellations); individuals |
| Operations | Corporate accounts on credit; **cash-heavy**; some payments to bank accounts (see §4.15) |
| Legacy data | Excel customer data → import tool |
| Timeline | Pilot runs a **90-day cycle**, then the product is marketed to other small hotels |
| Observation site | Sunset Boulevard (one week of front-desk / night-audit / housekeeping observation before UI freeze) |
| Success metrics | Pilot NPS, time-to-first-booking, cash-variance reduction, night-audit completion time (all four) |

---

## 2. Answer log (Q1–Q35) and design impact

| # | Answer (summary) | Impact |
|---|---|---|
| 1 | Pilot = Sunset BnB, 3 properties | §1; usability tests at Boulevard |
| 2 | Y1: Creek + Boulevard (Karachi), Ramna (Islamabad) | Multi-city tax/compliance variants from day one |
| 3 | 30-day free trial; four commercial models (see §4.11); WhatsApp API after pilot approval | Subscription engine supports trial, one-time fees, revenue share, module add-ons, custom, on-prem licence |
| 4 | Sales: direct + resellers + associations; white-label demand | `reseller`, per-tenant brand/domain (§4.13) |
| 5 | Benchmark: **Cloudbeds**; legacy systems exist | Feature-parity checklist vs Cloudbeds workflows (concepts only, no copying); migration tooling |
| 6 | Team 3–5 people; dates ASAP; marketing budget 2M (currency assumed PKR — confirm) | **Plan re-baselined** (§6); MVP sliced into releases |
| 7 | Reservation state model approved | D-06 final |
| 8 | Two apps approved + a **management app** | §4.6 (management module in staff app + responsive dashboard) |
| 9 | Channel manager = Phase 2, after PMS runs in the properties | Confirms D-14 |
| 10 | Gateway = **PayFast** (portal access obtained; IP allow-listing available) | First `PaymentProvider` adapter (§4.12 / ADR D-26); API terms to verify |
| 11 | WhatsApp click-to-chat first, API later | Confirms plan |
| 12 | Many unpaid OTA cancellations; sell to walk-ins and reconfirm with the other guest. Booking.com offers no prepaid option for Pakistani hotels | §4.8 reconfirmation & at-risk inventory; **§4.18 guarantee-by-deposit via PayFast** |
| 13 | Dual pricing local/foreign (+discounts), weekend & seasonal, extra-person/breakfast/extra-bed pricing; quotes **exclude tax**, tax added at end; invoice tax differs by line type and city | §4.7; **tax inputs pending from stakeholder** |
| 14 | No-show/cancellation charges stated in quote, settled per property; OTAs may not pay | §4.9 OTA fee receivable, per-property policy templates |
| 15 | No hostel/per-bed/hourly | Removed from roadmap (per-bed P3 and day-use P2 dropped) |
| 16 | Services (restaurant/laundry/transport) run **inside** PMS | F&B-lite + service catalogue move into R1/R2 (§5) |
| 17 | Staff UI: **Urdu + English, user-selectable**; guest documents English | Urdu moves from P2 to **MVP for staff** (§4.4) |
| 18 | Management reports: occupancy, revenue, outstanding, upcoming reservations, sales | Priority KPI set for management module |
| 19 | No tax/fiscal integration now | Later via `FiscalProvider` |
| 20 | Guest/authority rules are dynamic by region and time (e.g., a nationality may need extra security in Karachi but not Islamabad) | §4.10 configurable compliance rules |
| 21 | No DPO/counsel; hosting anywhere except India, ideally in Pakistan with a local provider | ADR D-16 revised; engage counsel (§10) |
| 22 | Hotels' own merchant accounts | Platform never holds funds (final) |
| 23 | Credit limits, NET 15/30 with aging | Matches corporate AR design |
| 24 | Identity build-vs-buy: "not sure" | **Recommendation revised** (ADR D-11) |
| 25 | ORM: "whatever is best" | Kysely + SQL-first migrations (D-03 final) |
| 26 | Legacy migration: Excel customer data | Import tool with dedupe in R1 |
| 27 | SLA important | §4.16 proposed SLA |
| 28 | Hardware guidance/resale; **scan/photo of CNIC & passport with OCR** | §4.2, §4.17 |
| 29 | No mandated vendors yet; open to proposals | Vendor shortlist in §4.12 |
| 30 | Every customer has own brand and domain | §4.13 white-label |
| 31 | Product owner: Irfan A Rehman | Decision authority |
| 32 | ID/guest data retained **until archived** | §4.14 (default confirmed; flagged) |
| 33 | Observation site: Sunset Boulevard | §1 |
| 34 | Third-party pen test/certification later | Pen test remains a pre-GA gate for external customers |
| 35 | All four success metrics | §1 |

---

## 3. New requirements received (summary)
1. **Digital loyalty programme** (points; Silver/Gold/Platinum; individuals and corporates).
2. **Self check-in for repeat guests** with stored/uploaded documents, app-based room allotment, "just walk in"; smart-lock keys later.
3. **Guest experience hub** in the guest app: food ordering, pickup/drop, ironing and other services, local attractions and activities (city tour, beach day), Wi-Fi/TV info, folio, payments, invoices, complaints, suggestions, reviews, contact management, hotel initiatives.
4. **Staff role model** extended (finance, audit, front desk, marketing, sales, accounts, cashier, HR, kitchen, admin, housekeeping, management, gate security…) and a **staff app that tells staff what's happening locally** (masjids, parks, golf, money exchange, food streets, events).
5. **Urdu UI** per user preference (priority: housekeeping and gate security).
6. **Travel agent / partner portal**: see inventory of associated hotels, book individuals and groups at agent rates, claim commissions — including an agent dealing with several hotels.

---

## 4. Specifications

### 4.1 Digital Loyalty Programme  — **P2 (R2)**; data model reserved in R1
- **Concepts:** `loyalty_program` (per tenant, or brand-level for groups), `loyalty_tier` (configurable; defaults Silver / Gold / Platinum), `loyalty_member` (guest **or** company), `loyalty_account` (balance), `loyalty_ledger` (**immutable** points postings: earn, redeem, expire, adjust, reverse — same discipline as the folio), `earn_rule` (per spend category, per night, per rate plan, bonus multipliers by tier/season), `redeem_rule` (points → folio credit, free night, upgrade, services), `tier_rule` (qualification by nights/spend/points over a rolling or calendar period, with downgrade grace), `loyalty_card` (digital card: QR/barcode + member number, shown in guest PWA/app, wallet pass later).
- **Corporate loyalty:** points can accrue to the **company account** (pooled, redeemed by the corporate admin) or to the **individual traveler**; contract setting decides (some corporates forbid employee perks). Tier benefits (late checkout, upgrades, breakfast, dedicated rate) are configurable benefit entries applied automatically as rate eligibility/service entitlements.
- **Integrity rules:** points are earned **at checkout/night-audit posting on settled, eligible revenue only**; reversal when a folio charge is reversed; redemption posts a folio credit with reason `LOYALTY_REDEMPTION` and is reflected in revenue reports (liability vs. discount treatment configurable — accountant to confirm); fraud controls (velocity, self-booking farming, manual adjustment needs approval and reason).
- **Scope:** programmes are **tenant-scoped** (a tenant's guests see only its programme). Cross-brand/third-party sharing is out of scope.
- **Reports:** members by tier, points issued/redeemed/expiring (liability), repeat rate, revenue by tier.

### 4.2 Self Check-in & Guest Experience Hub
**Self check-in (P2 / R2; staff-side ID capture + OCR assist in R1)**
- **Repeat-guest fast path:** returning guest with a verified profile (ID on file, consent on file, signed registration template) gets a pre-filled pre-check-in; on the day, when the room is ready (clean/inspected and assigned), the app shows **room number, directions and instructions**; guest "just walks in". Until smart locks exist, a key/card is collected at a staffed desk/**gate security** with a one-tap handover (the front desk sees "Pre-checked-in, ready" and does a 30-second verification instead of data entry).
- **Documents:** CNIC/passport photo upload via web/app **or** captured by staff via camera/scanner; **OCR extracts fields** (name, number, DOB, expiry) which the guest/staff **confirms** (OCR is assistive, never auto-verified). OCR options to evaluate in a spike: managed cloud OCR, on-device ML, or a self-hosted engine; accuracy on CNIC (bilingual, security-printed cards) and passport MRZ must be tested with real samples; NADRA verification is **not assumed available**. Mobile capture quality checks (blur, glare, crop).
- **Compliance gating:** property **compliance rules** (§4.10) evaluated at pre-check-in; flagged guests are routed to staff and never auto-allotted.
- **Room allotment:** rule-based auto-assign suggestions (room type booked, preferences such as floor/bed/smoking, cleanliness state, connecting rooms, VIP); staff-approvable; the same assignment constraint as everywhere (D-05).
- **Smart locks (P3):** `DoorLockProvider` issues PIN/QR/BLE/mobile key at check-in, revokes at checkout/room move; failures fall back to desk key; keys are never the only way in.
- **Security:** self check-in requires verified phone/email OTP, signed token bound to the reservation, rate limits; first-time guests (no verified profile) always have a staff verification step; fraud signals (name mismatch vs booking, payment mismatch) route to staff.

**Guest Experience Hub (P2 / R2, delivered in guest PWA; native app later)**
| Area | Capability | Notes |
|---|---|---|
| Stay | Reservation, digital registration, room/directions, Wi-Fi name & password, TV/entertainment channel list, house rules, contacts | Property **content manager** (tenant-editable, English) |
| Services | Order food (room service/restaurant menu), request hotel **pick-up & drop**, ironing, laundry, housekeeping, extra bed/mattress, late checkout | Uses the **Service Catalogue** → creates tasks for kitchen/transport/HK; charges post to folio (validated) |
| Discover | Nearby places, attractions, things to do, events; **book experiences** (city tour, beach day, activities) | `local_guide` (POIs by city/category/geo, tenant-curated) + `experience` items in the service catalogue with partner vendors (cost & commission tracking later) |
| Money | Folio view, pay (PayFast), invoices download, express checkout | Hotel's own merchant account |
| Voice | **Complaints, suggestions, reviews/ratings, talk to management**, contact | `feedback` (type: complaint / suggestion / review / compliment), complaint **case** with SLA, owner, status, resolution, escalation to GM; sentiment tagging (AI, P3); review prompts post-stay (internal reviews first; public-review links optional) |
| Brand | **Sunset initiatives** page and other CSR / about content; offers & loyalty (§4.1) | Tenant-configurable content blocks |
- **Complaint case states:** `NEW → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED` (+ `ESCALATED`, `REOPENED`); SLA timers; internal notes; link to reservation, room, department; reporting by category and response time. Staff can log complaints on behalf of guests (R1-lite: manual log; guest-facing in R2).

### 4.3 Staff Roles & Access — **MVP (R1)**
Additions to the role catalogue (system roles, cloneable): **Admin (tenant/property)**, **Management/Executive** (read-only dashboards across properties), **Finance Officer**, **Accounts Officer**, **Internal Auditor**, **Marketing**, **Sales**, **HR**, **Kitchen / Chef**, **Kitchen Cashier/Waiter** (order taking), **Gate Security** (arrivals list, vehicle log, visitor log, guest-verification checks; no financial access), **Transport/Driver** (P2), **Concierge**.

Departments are first-class (`department` table) and are the unit for task routing, role scoping and the staff-app home screen. Extended property matrix (additions to `01` §E.3; legend as before):

| Capability | Mkt | Sales | HR | Kitchen | Finance/Accts | Audit | Gate Sec | Mgmt |
|---|---|---|---|---|---|---|---|---|
| Reservations (view) | – | R | – | R (in-house meal info only) | R | R | R (today's arrivals only, masked) | R |
| Create reservation | – | W | – | – | – | – | – | – |
| Guest profiles | R (consented marketing data, masked) | R | – | – | R | R | R (name/vehicle only) | R |
| Campaigns / loyalty config | F | R | – | – | – | – | – | R |
| Corporate accounts | – | F | – | – | W | R | – | R |
| Folio / payments | – | – | – | Post F&B charges | F | R | – | R |
| Staff records / users | – | – | F (HR scope only) | – | – | R | – | R |
| Kitchen orders / menu | – | – | – | F | R | R | – | R |
| Visitor / vehicle log | – | – | – | – | – | R | F | R |
| Reports | marketing | sales | HR | F&B | financial | all (read) | – | all KPIs |
| Audit log | – | – | – | – | – | F | – | R |

- HR scope: staff directory, role requests, attendance feeds (P3); HR **cannot** see guest data. Hotel-staff PII is protected like guest PII.
- **Staff app home (role-driven):** "My tasks", "Today", role tools, plus a **Local Info** tab: masjids with prayer-time links, parks, golf, money exchange, food streets, events — fed by the same `local_guide` content as the guest hub (staff can answer guest questions; concierge can recommend and book experiences). **P2.**

### 4.4 Urdu & Language Preferences — **MVP for staff (R1); guest documents English**
- Per-user `preferred_locale` (en / ur) switchable at any time; **default by role template** (e.g., housekeeping and gate security default to Urdu) — the user can override.
- **R1 coverage:** staff mobile app 100% bilingual (housekeeping, maintenance, gate security, kitchen order screens); web PMS bilingual for front-desk-critical screens first, then the rest (translation backlog tracked; untranslated strings fall back to English).
- Technical: RTL layouts via logical CSS/Flexbox mirroring, Urdu **Nastaliq-capable** font (Noto Nastaliq Urdu or similar; check rendering on low-end Android), Urdu numerals policy (Latin digits default for money/room numbers), bidi-safe mixed text (room numbers, names), icon-first UI for low-literacy users, optional **voice prompts** later.
- Translation workflow: ICU message catalogues, in-context review by Sunset housekeeping/security staff (native-speaker QA), pseudo-localisation tests, screenshot tests in both directions, Urdu glossary for hospitality terms.
- Guest-facing documents (invoices, registration cards, confirmations) stay English at launch; the template engine already supports additional locales.

### 4.5 Travel Agent / Partner Portal — **R2 (within one tenant); cross-tenant federation later**
**Within a tenant (R2):** a travel agent is a `company` (type `TRAVEL_AGENT`) with a contract: associated properties, rate plans/discount rules, commission terms, credit/prepay terms, allowed booking types. Agent users log into the **partner portal** (own realm), see **only the properties on their contract**, search availability by dates/occupancy, see **their** rates (net, markup, or discounted-from-rack, per contract), and **book in one click** for individuals or **groups** (special group price, rooming list, cut-off — groups are R2). Bookings carry source `TRAVEL_AGENT` + agent id for production reports.

**Commission claims (R2):** `commission_rule` (percent of room revenue, net-rate model with no commission, flat per night, tiered by volume, on checked-out/settled revenue only, excluding taxes/F&B unless agreed) → `commission_accrual` created when the eligible folio is settled → agent sees accruals in the portal → `commission_statement` (period) → approval by hotel accounts → payment (bank/cheque) recorded against `agent_payable` → cancellation/no-show reversals handled automatically. Payment of commission is separate from guest folios (agent payable ledger, mirrored to AR/AP in finance exports).

**Agent dealing with multiple hotel companies ("one login, 5 hotels, on a platform serving 10 hotels")** — this crosses tenant boundaries and needs an explicit design decision:
- Agent identity is a **platform-level `partner_identity`** (like guest identity). Each hotel tenant independently approves a `partner_connection` (contract) with that identity. Tenant data stays isolated: the portal **fan-outs per connected tenant** under that tenant's context and merges only the *contracted view* (availability, agent rates, restrictions) — never a cross-tenant join, never other tenants' guests/reservations.
- Reservations are created **inside the hotel's tenant** (single-hotel bookings; multi-hotel itineraries as separate bookings under a client-side cart). Agent sees only reservations that agent created.
- Needs: inter-tenant data-sharing consent in the SaaS agreement, per-tenant rate confidentiality (an agent must not see another hotel's rates), agent KYC, abuse/rate-limit controls. **Recommendation:** deliver *within-tenant multi-property* agents in R2 (covers Sunset's 3 properties and groups), and deliver *cross-tenant federation* in R3 once ≥ 5–10 hotel tenants are live and a commercial/legal framework exists (this becomes the seed of a marketplace channel).
- Staff-entered agent bookings (agent phones/WhatsApps the hotel) are in **R1** via the corporate/agent account machinery (rates + manual commission report).

### 4.6 Management Experience — **R1 KPI module; R2 enhancements**
- A **Management** role/module in the staff app (and a responsive web dashboard) with the owner's priority set: **occupancy, revenue (ADR/RevPAR), outstanding receivables, upcoming reservations, sales (by source/corporate/agent), cash position and variance, pending approvals, complaints SLA**; three-property comparison; push alerts for exceptions (large discounts, voids, failed night audit). Read-only, fast, snapshot-based (immutable daily stats) with live "today" tiles.
- Decision: **not a separate binary**. One staff app with role-based modules (Housekeeping, Maintenance, Security, Kitchen, Front Desk tablet, Management) — fewer store submissions for a 3–5-person team; reconsider if management demands a distinct brand/app.

### 4.7 Rates, Taxes & Quotes (Pakistan realities, configurable) — **MVP**
- **Dual pricing:** rate plans eligible by guest `residency` (resident / non-resident) derived from nationality/passport vs CNIC (rule-based eligibility, previously P2 → **M**). Both price lists live in one rate plan structure (`rate_value.audience`), with discount rules.
- **Pricing components:** weekend (day-of-week set per property), seasonal calendars (Eid/Ramadan/summer templates), **extra person**, **extra-person breakfast**, **extra bed/mattress** (as add-on items with per-night price and inventory limit), child rules, corporate discounts, manual discounts with limits/approvals.
- **Quote rule:** quotes show rates **excluding tax**, then a final "taxes" line and grand total; the folio/invoice then applies the **jurisdiction's actual tax rules per line type**.
- **Line-type taxation:** room, F&B, laundry and other services carry different tax treatments (rates differ by line type and by province/Islamabad). Each hotel can define its tax rules (`tax_rule` per property, effective-dated). **Rate-component allocation ("package allocation")**: when a rate bundles breakfast with the room, the system can split the charged price into *room* and *breakfast* components using configured standalone prices/allocation percentages so each component takes its own tax treatment. Guardrails: allocations must reflect configured, published component values (not arbitrary), are versioned and audited, and are shown in invoice detail. **The tax advisor must confirm the allowed allocation method per jurisdiction before Sunset's go-live.**
- **Pending from stakeholder:** the detailed tax calculation worksheet(s) for Sindh and Islamabad (and Punjab for future customers); invoice format samples. They become golden test fixtures.
- **Conference room (Boulevard):** sold **hourly or full-day**, so a bookable *space* resource with a time-slot calendar (separate from room inventory; no hourly *room* sales) moves up to **R1b**: hourly/half-day/full-day pricing, conflict-free slot booking (exclusion constraint on time ranges), setup/changeover buffer, add-ons (catering via service catalogue), posting to a guest folio or a company/event folio, and a Spaces calendar next to the rack.

### 4.8 OTA No-Show Risk, Reconfirmation & Walk-in Handling — **MVP (manual OTA entry); automation with Channel Manager (R3)**
- **Overbooking default = 0.** Instead of blanket overbooking, add **"at-risk" reservations**: OTA/unguaranteed bookings flagged `payment_status = UNPAID` and `confirmation_status = UNRECONFIRMED`. A **reconfirmation workflow** creates a task N days/hours before arrival (WhatsApp click-to-chat template: "Please confirm your arrival"). Outcomes: reconfirmed (clears risk), no response by a configurable deadline (reservation becomes **releasable**), or guest cancels.
- **Sell-through of at-risk inventory:** the walk-in screen shows when the only available units are tied to *at-risk* reservations and offers: (a) quote walk-in while attempting reconfirmation, (b) hold walk-in as an `OPTION` linked to the at-risk reservation ("takes the room if the OTA guest doesn't arrive by T"), (c) release the at-risk reservation as `NO_SHOW` early (per OTA rules) when approved. This gives hotels the benefit of controlled overselling **without ever silently double-selling a physical room** — the physical-room constraint still holds; conflicts are resolved by explicit staff action recorded in audit.
- Optional `overbook_limit` per room type/date (default 0) remains available for properties that want it; the **walk (relocation) workflow** is R3.

### 4.18 Guarantee-by-Deposit for OTA Bookings (revenue protection) — **R1b**
**Problem (stakeholder):** Booking.com does not offer prepaid options for Pakistani hotels, so OTA bookings carry no guarantee; no-shows and late cancellations lose revenue.
**Workflow (PMS-side, using PayFast, hotel's own merchant account):**
1. OTA reservation arrives (manually entered in R1; imported when the channel manager ships) flagged `UNGUARANTEED / AT_RISK`.
2. Staff (or an automatic rule per rate plan) opens **Request Guarantee**: system computes the deposit from the property's guarantee policy (first night, a percentage, or fixed amount) and creates a **PayFast payment link** plus a **deposit invoice/proforma** (not a tax invoice until settled, per advisor rules); sent by WhatsApp click-to-chat or email with a payment deadline.
3. States: `GUARANTEE_REQUESTED → GUARANTEED (paid) | EXPIRED (not paid by deadline) | CANCELLED`. A paid deposit sets `guarantee_type=DEPOSIT`, lifts the at-risk flag, and posts to the **guest-advance liability** (`10` §5). Partial payment is supported (deposit now, balance at stay).
4. **Cancellation/no-show handling from the snapshot policy** (e.g., free until 72 hours before arrival; later cancellation or no-show = forfeit deposit/charge first night): the system proposes the fee, applies it against the deposit (forfeiture posting with reason), refunds any excess through PayFast or bank transfer, and records an OTA claim in `ota_receivable` where the OTA is liable instead (`4.9`).
5. If the deposit is not paid by the deadline, the booking stays at-risk and follows the reconfirmation/release rules (`4.8`); the hotel decides.
6. **Dashboard "Revenue protection":** guaranteed vs unguaranteed OTA bookings, deposit conversion rate, no-show and late-cancellation revenue recovered, revenue lost, at-risk revenue next 14 days, receivables from OTAs.
**Policy and platform rules to verify before launch (do not assume):** (a) Booking.com's partner terms and the cancellation policy shown to the guest at booking — fees beyond that policy, or soliciting off-platform payments, may breach the OTA contract or be disputable by the guest; (b) restrictions on how hotels may contact OTA guests and use masked contact details; (c) whether card-on-file / tokenised charges are available through PayFast (otherwise the model is deposit-first, which this design already is); (d) consumer-protection and refund rules, and the tax treatment of forfeited deposits and cancellation fees (`10` §9). Policy wording, guest consent text and template messages are tenant-configurable, English.

### 4.9 Cancellation / No-Show Fees & OTA Receivables — **MVP**
- Cancellation/no-show charge rules per property and per rate plan (windows, % or nights, caps), **printed in the quote and snapshotted on the booking** (D-06/H.5). Owner-configurable per property; templates provided.
- When the guest is liable: post the fee to the folio and collect. When an **OTA** is liable (or doesn't pay): create an `ota_receivable` (OTA, booking reference, amount, status `CLAIMABLE → CLAIMED → RECEIVED | DISPUTED | WRITTEN_OFF`) so the property can chase or write off with a reason; reported in aging. Waiver option (with reason + permission) for goodwill.

### 4.10 Authority / Security-Advisory Compliance Rules — **MVP**
Regional and time-varying requirements (e.g., certain nationalities need additional security arrangements in a given city but not another; police reporting formats) are handled by a **configurable rule engine**, not code:
- `compliance_rule` (tenant/property scope, effective dates, **conditions**: nationality, residency, city/property, visit dates, party size; **actions**: `INFO`, `WARN`, `REQUIRE_APPROVAL` (GM), `REQUIRE_TASK` (e.g., arrange escort/security), `BLOCK_BOOKING`, `REQUIRE_DOCUMENT`, `NOTIFY` role/email; message text; reason code).
- Evaluated at quote/booking, pre-check-in and check-in; every hit and override is audited. Rules are editable by authorised managers, versioned, and changeable without a release.
- `authority_report_template` (per jurisdiction): guest-register exports (CSV/PDF/whatever format the authority requires), generated per day or on demand; formats gathered at onboarding.
- Legal note: rules that restrict acceptance by nationality reflect an operator's security/legal obligations; counsel should review wording and approval flows to avoid discrimination exposure. The platform provides the mechanism, not the policy.

### 4.11 SaaS Commercial Model (Sunset's four models) — **configuration, not code**
| Model | How the engine represents it |
|---|---|
| 1. One-time + % of monthly revenue | `SubscriptionItem(kind=ONE_TIME)` + `UsageMetric(PROPERTY_ROOM_REVENUE)` with a `percent_of_revenue` price; revenue measured from **night-audit snapshots** (room revenue ex-tax by default; configurable base), invoiced monthly in arrears; floor/cap options |
| 2. One-time + monthly by rooms/properties + module add-ons | `PlanPriceTier` (rooms), `per_property` items, `AddOn`s: **F&B module, mobile app, corporate module, self check-in, loyalty, partner portal, channel manager, booking engine, etc.** each independently priced and entitlement-gated |
| 3. Custom (large hotels, corporates) | Per-tenant price overrides, negotiated terms, custom contract documents, invoicing schedules |
| 4. On-premises / self-hosted (later) | See §4.12; licence key + entitlements file, update channel, support plan |
- **30-day free trial** (`TRIALING`), converting to paid or expiring to read-only; trial tenants flagged for demo data and may be hard-capped (properties/rooms/users).
- Revenue-share requires trustworthy revenue data: the immutable night-audit snapshot is the metering source; tenant can view the same statement (transparency reduces disputes). Hotels' own merchant accounts mean the platform **invoices** the hotel; it does not deduct from guest payments.
- Resellers: `reseller` entity, commission on subscriptions, branded onboarding (R2+).

### 4.12 Hosting, Deployment & Integrations
**Hosting (ADR D-16 revised):** India is excluded. The owner prefers a **Pakistan-based provider**; a data-protection posture has not been established and no counsel is engaged.
- *Option A — Local provider / co-location in Pakistan:* best for sovereignty and latency; fewer managed services (DB HA, backups, object storage, monitoring all become our operational burden); needs 24/7 ops capability a 3–5-person team lacks; provider SLAs vary.
- *Option B — AWS Middle East (UAE / Bahrain), Terraform-managed:* mature managed services, small ops burden, fast time-to-pilot; data leaves Pakistan.
- **Recommendation:** build **cloud-portable** (containers, PostgreSQL, Redis, S3-compatible storage such as MinIO, Terraform/Compose/Helm-neutral deployment, no proprietary-only services in the core path) and **start the 90-day pilot on a managed Middle-East region** *or* on a reputable local provider **only if** it offers managed PostgreSQL/backups/monitoring with documented SLAs. Move to / offer Pakistan hosting once counsel confirms residency requirements and an operations partner is in place. The same portability serves the **on-prem** product. Decision needed (§10).
- **On-prem later:** single-tenant packaging, licence enforcement/offline activation, upgrade and backup tooling, remote-support protocol, hardware sizing guide — R4; keep it feasible by avoiding cloud-proprietary dependencies in core.

**Integrations (shortlist, subject to verification):**
| Need | Proposal |
|---|---|
| Online payments | **PayFast** adapter first (hotel's own merchant account); then JazzCash/Easypaisa/cards via additional adapters. Verify: merchant onboarding, API/webhook signing, refunds/voids, settlement reports, fees |
| WhatsApp | Click-to-chat now; official Business API via a BSP after pilot approval |
| SMS | Local aggregator for OTP/reminders (R1: OTP for self check-in is R2) |
| Accounting | CSV journal export first; QuickBooks/Xero/SAP connectors later |
| Smart locks | Vendor chosen later behind `DoorLockProvider` |
| ID OCR | Spike in R1 (see §4.2) |

### 4.13 Per-Customer Branding & Domains (white-label) — **R1 basics, R2 full**
- `tenant_brand` and `property_brand`: logo, colours, fonts, email sender identity, document templates, app/PWA name and icons; **custom domains** per tenant for guest-web, booking engine, corporate/partner portals (CloudFront/ACM or local equivalent; ACME where self-hosted).
- Staff PMS: tenant logo/colours (R1). Guest PWA, booking engine, portals: full theming (R2). **Native white-label apps** (store accounts per brand) are a commercial add-on and not planned before R3.

### 4.14 Data Retention Default
Stakeholder default: **guest and ID data are retained until the record is archived** (no automatic expiry). Implemented as the default `data_retention_policy` with: encryption, access reasons and logging (unchanged), tenant-configurable overrides, archival workflow (archive → restricted access → purge on request or policy), DSAR/erasure by anonymisation. **Flag:** indefinite retention of identity documents increases breach impact and may conflict with future data-protection law — revisit once counsel is engaged; the setting is a policy value, not code.

### 4.15 Cash & Payment-Account Integrity (product position) — expanded in [`10`](10-accounting-and-tax-architecture.md)
Sunset reports cash-heavy operations and some receipts into a personal bank account for non-tax payments. The platform will **record every receipt** against a configured **payment account** (`payment_account`: cash drawer, company bank, other) and will not offer a way to take revenue or payments off the ledger or to issue documents outside the audit trail. Specifically: all payments must reference an account, accounts not owned by the legal entity must be explicitly flagged and appear in finance/audit reports, every posting is immutable and attributable, and cashier/night-audit reconciliation covers all tenders. Tax treatment of any payment method is the hotel's and its advisor's responsibility; the product's job is complete, tamper-evident records. This protects the owner too (staff skimming, disputes) and is what makes the data usable for tax compliance later.

### 4.16 Proposed Pilot SLA (for approval)
| Item | Proposal |
|---|---|
| Availability | 99.5% monthly (R1), 99.9% target at GA; excludes announced maintenance (off-peak, ≤ 4 h/month) |
| Support hours | 08:00–24:00 PKT daily for pilot (front desk and night audit cover); P1 on-call 24/7 |
| Response / resolution (P1 outage or money/inventory error) | respond ≤ 30 min, workaround ≤ 4 h |
| P2 (major feature degraded) | respond ≤ 2 h, fix ≤ 1 business day |
| P3 | respond ≤ 1 business day |
| Languages | English and Urdu support staff |
| Data | RPO ≤ 5 min, RTO ≤ 4 h; daily backup verification |
| Contingency | Downtime pack (arrivals / in-house / balances) so the property keeps operating |
| Reporting | Monthly SLA report; incident post-mortems for P1 |

### 4.17 Hardware & Capture
Guidance (and optional resale): front-desk PC/tablet, **signature pad or tablet**, **ID scanner / document camera**, receipt/A4 printers, **UPS/power backup**, secondary ISP/LTE failover router, Android devices for housekeeping/security (min spec defined after performance budget), barcode/QR scanner for loyalty cards (optional), later smart-lock gateways. Publish a tested-hardware list; ID-capture station spec depends on OCR spike.

---

## 5. Reclassification of features (changes to `01` §F and `07` §AN/AP/AQ)

| Feature | Before | Now |
|---|---|---|
| Urdu UI (staff) | P2 | **MVP (R1)**, user-selectable per user |
| Nationality/residency-based (dual) rates | P2 | **MVP (R1)** |
| Extra bed/mattress, extra-person breakfast pricing | MVP (basic) | MVP (explicit) |
| Package allocation for tax | P2 | **MVP (R1)**, configurable per property |
| Compliance / security-advisory rule engine; authority report templates | MVP (export only) | **MVP (R1)** configurable engine |
| OTA unpaid-cancellation tooling: reconfirmation, at-risk flag, OTA receivable | — | **MVP (R1)** |
| Staff ID capture (camera/scanner) | MVP | MVP; **OCR assist** in R1 (spike → ship if accurate), else R2 |
| PayFast online payment | P2 | **R1-late** (payment link) — subject to PayFast API verification |
| Service catalogue + staff-posted services (incl. F&B-lite, laundry, transport) | partly P2 | **R1 (staff-side)**; guest ordering R2 |
| Kitchen order screen / F&B-lite inside PMS | P2/P3 | **R1-late / R2** |
| Management KPI module | P2 | **R1** |
| Loyalty programme | P3 | **P2 (R2)** |
| Self check-in (repeat guests), guest hub, complaints/reviews | P2 | **R2** (unchanged tier, expanded scope) |
| Travel-agent staff-entered bookings | P2 | **R1** |
| Travel-agent portal (within tenant) + commissions | P2 | **R2** |
| Cross-tenant agent federation | — | **R3** |
| Local guide / city & activity content | — | **R2** |
| Marketing role/campaigns | P3 | Role in R1; campaigns P3 |
| Hourly / day-use stays; per-bed (dorm) | P2 / P3 | **Dropped** (not needed) |
| Meeting/conference room | P2 (definition) / P3 | **Bookable space (hourly/full-day) in R1b** |
| Channel manager | P2 | R3 (after R1 + R2 are stable at Sunset) |
| On-premises edition | — | R4 |

---

## 6. Re-baselined plan (team of 3–5)

My earlier timeline (pilot-ready ≈ month 7–8) assumed 10–12 people and **no longer holds**. Same scope with 3–5 people would take roughly 2–2.5× longer. To meet "as early as possible" the plan is re-sliced into **releases** and a **phased pilot go-live** instead of one big MVP. Estimates below are planning-grade and assume 4 engineers (2 backend, 1 full-stack/web, 1 mobile/web), the product owner part-time as domain expert/UAT, AI-assisted development, and bought-in (not built) components where possible.

| Release | Content | Target |
|---|---|---|
| **R1a — "Boulevard walking skeleton"** | Tenancy/RBAC/audit; property setup; rooms/types; rates (incl. dual pricing, corporate); availability; reservations + rack; guests + Excel import; check-in/out + registration card; folio, taxes, invoices, cash/bank payments, cashier; HK board + Urdu/English staff app (housekeeping, security); basic reports | **Month 6–8** — go live at **Boulevard (9 rooms)** with parallel paper/Excel run |
| **R1b — Sunset complete** | Night audit full; **conference-room (hourly/full-day) booking; guarantee-by-deposit for OTA bookings (§4.18);** corporate accounts + AR + aging; Creek (Karachi) and Ramna (Islamabad) with their own tax rules; OTA reconfirmation/receivables; compliance rules; management KPI module; kitchen/service posting; PayFast payment links; maintenance + OOO | **Month 9–11** — all 3 properties; 90-day pilot clock starts |
| **R2 — Guest & partners** | Guest PWA hub (self check-in, services, local guide, complaints/reviews, folio/pay), loyalty, travel-agent portal + commissions, corporate portal, WhatsApp API, SMS OTP, bookable spaces, white-label guest/booking domains, booking engine | **Month 12–17** (during/after pilot; overlaps marketing to other small hotels) |
| **R3 — Distribution & scale** | Channel manager (first OTA, then others), CRS, groups, cross-tenant agent federation, revenue tools, reconciliation, ERP connectors | Month 18+ |
| **R4 — Enterprise** | On-prem edition, SSO, smart-lock adapters, native white-label apps, AI | Later |

**Scope management rules for a small team:** (1) the pilot's Excel/paper replacement drives priority; (2) buy/embed commodity pieces (PDF, email, OTP, OCR trial, auth libraries); (3) no feature enters R1 unless Sunset's operation needs it in the first 90 days; (4) one synchronous team ritual — weekly demo at Boulevard; (5) keep the invariant checkers and tenant-isolation tests from day one (they are cheap now, expensive later).
Consequences for earlier docs: M0–M9 in `07` §AR map to R1a/R1b as above; the 10–12-person estimates there are superseded.

---

## 7. Data-model delta (additions to `05` §AF.8)
`loyalty_program, loyalty_tier, loyalty_member, loyalty_account, loyalty_ledger, loyalty_rule, loyalty_card` · `partner_identity, partner_connection, partner_user, commission_rule, commission_accrual, commission_statement, agent_payable` · `feedback, complaint_case, complaint_event` · `local_guide_poi, experience, content_block` (guest hub content) · `compliance_rule, compliance_hit, authority_report_template` · `user_preference (locale, notifications), department` (already), `visitor_log, vehicle_log` · `ota_receivable, reconfirmation_task, at_risk_flag` · `payment_account` · `tenant_brand, property_brand, tenant_domain` · `reseller, price_override, trial` · `rate_value.audience (resident/non-resident), rate_component_allocation, addon_item (extra bed, breakfast)` · `ocr_extraction (confidence, reviewed_by)` · `space` and `space_booking` (R2).

## 8. New / amended architecture decisions
See `08` amendments: **D-11** (identity — revised), **D-12** (mobile — management module, one staff app), **D-16** (hosting — revised, portability), and new **D-24** (partner identity & cross-tenant federation), **D-25** (loyalty as an immutable ledger), **D-26** (PayFast first, adapter), **D-27** (compliance rule engine), **D-28** (release plan for a small team).

## 9. Risks added
| Risk | Mitigation |
|---|---|
| 3–5-person team vs very large scope | Release slicing, phased go-live, buy-not-build, strict R1 gate |
| Tax allocation/quoting rules vary by province and are subject to interpretation | Configuration engine + advisor sign-off + golden fixtures from Sunset's worksheets |
| Hosting/residency undecided; no counsel | Portable build; decision in §10; counsel engagement |
| Cash and off-ledger practices clash with a tamper-evident system | §4.15 position; owner alignment before go-live |
| OCR accuracy on CNIC/passport | Spike with real samples; human confirmation always required |
| Cross-tenant agent portal weakens isolation if rushed | Defer to R3; fan-out design only; explicit consent contracts |
| Indefinite ID retention | Policy setting, encryption/access logging, revisit with counsel |
| PayFast documentation/merchant onboarding unknown | Start onboarding now; adapter behind interface; cash/bank-transfer fallback |
| Urdu QA and fonts on low-end devices | Native-speaker review, device matrix testing |

## 10. Items needed from the product owner
1. **Tax worksheets** (Sindh, Islamabad) and sample invoice formats; how breakfast/room allocation is currently done, and confirmation with the tax advisor.
2. ~~Room counts~~ (received: Boulevard 9, Creek 10, Ramna 8). Still needed: room **types** per property, staff counts by department, current Excel structures (guests, corporates, rates), conference-room pricing (hourly/half/full day).
3. ~~Hosting decision~~ — **decided: AWS** (portable build retained). Remaining: choose region at M0 (UAE `me-central-1` or Bahrain `me-south-1`, subject to service availability), and legal review of residency once counsel is engaged.
4. **Identity:** confirm the revised recommendation (D-11): library-based auth inside our codebase, no managed IdP.
5. ~~PayFast~~ — **portal access obtained**; IP allow-listing possible. Next: share API/webhook documentation and sandbox credentials with the dev team (never in chat or the repo — use Secrets Manager); confirm refund/void, card-on-file and settlement-report support.
6. Confirm the **marketing budget currency** and whether the 3–5-person team is fixed; who the engineers are (skills drive the stack choices).
7. Approve the **pilot SLA** (§4.16) and the **release plan** (§6).
8. Confirm the **cash/payment-account position** (§4.15).
9. Engage a **tax advisor and data-protection counsel** (independent of the pilot).
10. ~~Observation-week staff~~ — **confirmed**. Next: agree the week's dates and a named contact per function (front desk, night audit, housekeeping, gate security, kitchen).
