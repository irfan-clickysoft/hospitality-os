# 07 — MVP Scope, Roadmap, Development Sequence, Risks, Stakeholder Questions
Covers **AN–AV** (checklist items 36–42).

---

## AN. MVP Scope — "Commercially viable first product"

**MVP thesis:** a hotel (5–100 rooms) can run its *entire daily operation* — reserve, check-in, bill, collect, clean, close the day, invoice corporate clients, and report to owners/accountants — without spreadsheets, and with better cash/leakage control than today. Distribution (OTA/booking engine) comes second because the operational core must be trustworthy first.

### AN.1 In scope (MUST HAVE)
1. **Platform:** multi-tenancy (RLS + tests), multi-property, organisations (legal entities/brands/groups), RBAC with scopes/limits/approvals, MFA for privileged roles, audit + data-access logs, entitlements, minimal back office (tenant provisioning, plans/prices config, manual subscription invoicing, support-access grant, feature flags).
2. **Property setup wizard** (steps 1–7, 9–11 + basic services) with bulk room creation/CSV, go-live checklist, opening-balance import.
3. **Inventory & availability** engine (counters + exclusion constraint), overbooking thresholds, OOO/OOS blocks.
4. **Rates:** plans (base/daily/weekend/seasonal/corporate/LOS/breakfast/NR/AP/long-stay), derived plans, occupancy pricing, restrictions (MinLOS/MaxLOS/CTA/CTD/stop-sell/window), rate calendar & bulk edit, versioned + audited.
5. **Reservations:** individual/phone/walk-in/corporate (staff-entered)/group-lite (multi-room), OPTION holds, state machine + history, unassigned/assigned, move/upgrade/downgrade with history, extend/shorten, cancel/no-show/reinstate with policy fees, duplicate warnings, source/channel/segment tracking.
6. **Room rack (tape chart)** with server-validated commands and keyboard support.
7. **Guests/CRM-lite:** profiles, preferences, VIP, notes, ID with encryption + access logging, consent, duplicate detection, blacklist.
8. **Front desk:** arrivals/departures/in-house, check-in, walk-in fast path, digital registration card + signature + PDF, checkout, room change.
9. **Folio & billing:** immutable postings, multi-folio, routing, split/transfer, deposits, adjustments/reversals, tax engine (+ PK config pack), invoices/credit notes.
10. **Payments:** cash, bank transfer with proof verification, manual card/POS slip, corporate credit; `PaymentProvider` abstraction + one **stub/manual adapter**; refunds (manual).
11. **Cashier:** sessions, float, drops, blind close, variance review.
12. **Housekeeping:** board, assignments, statuses (separated), inspection, DND flag, staff mobile app (HK).
13. **Maintenance:** tickets, technician assignment, OOO blocks integrated with inventory; mobile create/update.
14. **Corporate accounts:** companies, contracts, negotiated rates, credit limit/terms, AR invoices, payments incl. WHT, aging, statements; **basic corporate portal** (view reservations/invoices/statements, booking request).
15. **Night audit:** business date, wizard, exceptions, posting, no-show, roll, immutable runs/snapshots, daily report pack.
16. **Reports:** operational (occupancy, availability, room status, arrivals, departures, in-house, HK, maintenance), revenue (ADR, RevPAR, room/total revenue, by source/room type/rate plan), finance (payments, cash, receivables, refunds, tax, outstanding folios, corporate aging), exports (CSV/PDF/XLSX).
17. **Notifications:** email (SES) + **WhatsApp click-to-chat deep links** + in-app; provider abstraction in place.
18. **Events/outbox, idempotency, observability, backups/DR baseline, contingency pack, i18n framework (English).**
19. **Integration seams (empty but real):** ChannelProvider, PaymentProvider, MessagingProvider, DoorLockProvider, AccountingExporter interfaces with test doubles; journal-export CSV.

### AN.2 Additional capabilities judged *necessary* for viability (beyond the brief's "expected MVP")
| Capability | Reason |
|---|---|
| Bank-transfer proof verification | Dominant Pakistani deposit pattern; fraud |
| WHT-aware corporate settlement | Otherwise corporate AR won't reconcile |
| Contingency/downtime pack | Connectivity/power reality |
| Guest/authority registration export | Likely legal requirement (confirm) |
| Data import (rooms, guests, in-house, future reservations) | Cut-over from existing systems |
| Comp/house-use handling & approvals | Leakage |
| Invoice numbering & tax-invoice layout per legal entity | Legal/tax |
| Support-access grant & audit | Onboarding without insecure credential sharing |
| Basic subscription enforcement | Otherwise no business |

## AO. Explicitly Excluded from MVP
Full Channel Manager & OTA adapters (Booking.com, Agoda, Airbnb, Expedia) · Direct booking engine/widget · CRS agent workspace · Automated pre-check-in & smart check-in · Digital keys/locks · Guest native app & guest portal · Online payment gateways (JazzCash/Easypaisa/cards) and pre-auth/capture · SMS/WhatsApp Business API automation · Push notifications · Corporate approval workflows and self-service corporate booking · Groups (blocks, cut-offs, rooming lists, master folios) beyond multi-room · Sales pipeline · Travel-agent commissions · Service-request fulfilment, airport transfer workflow, F&B/POS APIs · Meeting/event management · OTA reconciliation · ERP integrations · Revenue management & AI · Multi-currency · Urdu/Arabic UI · Offline check-in · SSO · Automated subscription billing · Public API/webhooks · Warehouse/BI · Loyalty · Per-bed (dorm) sales.

---

## AP. Phase 2 Roadmap (target: 6–9 months after MVP GA)
**P2.0 Money in:** first online payment gateway + wallets (hosted pages), payment links (WhatsApp), pre-auth/capture, settlement import & reconciliation basics, subscription auto-billing.
**P2.1 Guest journey:** WhatsApp Business API (official) + SMS, automated pre-check-in (guest-web PWA), express checkout, room-ready notices, Urdu UI, guest web portal.
**P2.2 Distribution:** direct booking engine + widget, promo/packages/add-ons, CRS multi-property search, iCal bridge, **first OTA adapter** then second (certified), channel mapping UI + monitoring, oversold/walk workflow.
**P2.3 Corporate & sales:** corporate self-service booking with approvals/cost centres/spend reports, groups (blocks/cut-off/rooming list/master folio), travel-agent commissions, light sales pipeline.
**P2.4 Operations:** service catalogue requests + tasks, airport transfer, minibar/lost & found, F&B posting API, staff app expansion (front-desk tablet), preventive checklists, auto night-audit, scheduled reports, group dashboards, public API + webhooks, custom roles.

## AQ. Phase 3 Roadmap (12–24 months)
Revenue management (forecasting, pace, recommendations w/ approval), AI assistants (NL reporting, comms, summaries, anomaly detection, maintenance categorisation), OTA financial reconciliation, ERP connectors (QuickBooks/Xero/SAP/Oracle), event & banquet module, native guest app (+ white-label), digital keys via DoorLockProvider adapters, POS deep integrations, offline edge node (if justified), multi-currency full, Arabic, SSO/SAML, loyalty, dorm/per-bed inventory, data warehouse & benchmarking, marketplace/partner API, GPS transfers, eKYC/OCR (where legally accessible), reseller/partner portal, regional deployment cells.

---

## AR. Development Sequence (MVP)

Assumptions: cross-functional team ≈ 10–12 (1 architect/lead, 4–5 backend, 3 frontend, 1 mobile, 1 QA/SDET, 0.5–1 DevOps, 1 product/UX designer). *Estimates are planning-grade only and must be re-baselined after approval.*

| Milestone | Scope | Exit criteria | Est. |
|---|---|---|---|
| **M0 Foundations** (weeks 1–6) | Monorepo, CI/CD, Terraform baseline (dev/stg), design system skeleton, tenancy + RLS + isolation test harness, Identity/RBAC/audit/outbox/idempotency, observability baseline, OpenAPI pipeline | Tenant-isolation suite green in CI; deploy to staging | 6 w |
| **M1 Property & Inventory** | Org hierarchy, property wizard (1–7), room types/rooms/amenities, business date, inventory_day, blocks | Create a 100-room property via CSV in <30 min; invariant checker | 5 w |
| **M2 Rates, Availability, Reservations** | Rate/tax engine, restrictions, quote/book, state machine, history, holds, assignment constraints, guests + dedupe | Concurrency tests (last room) pass; property-based rate tests | 8 w |
| **M3 Room Rack + Front Desk** | Rack, arrivals/departures, check-in/walk-in, registration card, room move | Front-desk usability test ≤ target clicks/time | 6 w |
| **M4 Folio, Payments, Cashier** | Postings, multi-folio, routing, invoices, deposits, manual payments, cashier sessions, refunds | Golden financial scenarios; ledger immutability tests | 8 w |
| **M5 Housekeeping & Maintenance + Staff app** | Tasks, board, mobile app w/ offline queue, OOO integration | HK day-in-life pilot | 6 w |
| **M6 Night Audit & Reports** | Audit workflow, snapshots, report pack, exports | Audit rerun/crash-resume chaos tests | 6 w |
| **M7 Corporate** | Companies, contracts, credit, AR, statements, WHT, basic portal | AR reconciliation scenarios | 6 w |
| **M8 Back office & Subscriptions** | Provisioning, plans, entitlements, support access, feature flags | Onboard tenant end-to-end w/o engineers | 4 w |
| **M9 Hardening & Pilot** | Pen test, load test, DR drill, data import tools, training material, pilots at 3–5 hotels (incl. one guesthouse and one 50+ room hotel with corporate clients) | Pilot exit review | 8 w |
Parallel tracks: UX research/prototype validation with real front-desk staff (from week 1); tax/legal advisory (from week 1); partner applications for OTAs/WhatsApp/payments (from M2); documentation & training content (from M5). *Indicative: pilot-ready ≈ month 7–8; GA ≈ month 10–12.*

**Sequencing logic:** tenancy/security first (retrofitting is fatal) → inventory before reservations → folio before payments before night audit → reports last (need trustworthy data). Front-desk UX validated early because adoption is the real risk.

---

## AS. Technical Risks
| # | Risk | Impact | Mitigation |
|---|---|---|---|
| T1 | Overbooking via race conditions or counter drift | Critical | Atomic updates, exclusion constraints, invariant checker, concurrency tests |
| T2 | Tenant data leakage | Critical | Defence in depth, RLS, isolation CI gates, pen test |
| T3 | Ledger corruption / imbalance | Critical | Immutable postings, constraints, nightly reconciliation checks |
| T4 | Night audit failures mid-run | High | Step ledger, idempotency, CAS roll, chaos tests |
| T5 | OTA integration complexity/certification delays | High | Phase 2, abstraction, early partner applications, aggregator option |
| T6 | Modular monolith decays into coupling | Medium | Enforced boundaries in CI, ADRs, ownership |
| T7 | Redis dependency (queue loss/eviction) | Medium | Outbox in PG, noeviction, replay tooling |
| T8 | RLS + pooling misconfiguration (context bleed between requests) | High | `SET LOCAL` in transaction only; tests using pooled connections; middleware that resets context |
| T9 | Performance of rack/reports at group scale | Medium | Windowing, snapshots, replica, load tests |
| T10 | Rate/tax engine complexity & rounding bugs | High | Property-based/mutation tests, golden invoices, accountant review |
| T11 | Timezone/business-date bugs | High | Explicit types, tests around midnight/DST/late arrivals |
| T12 | Mobile offline conflicts | Medium | Idempotent commands only, server truth |
| T13 | Dependency on unproven local gateways/SMS aggregators (uptime, docs quality) | Medium | Adapters, fallback methods, sandbox tests |
| T14 | Scope creep from a very large brief | High | Strict MVP gate, change control |
| T15 | Key-person/knowledge concentration | Medium | ADRs, pairing, runbooks |
| T16 | PDF/HTML rendering security/perf | Low-Med | Sandboxed worker, no remote fetch |
| T17 | ID-document storage scale/cost & legal retention | Medium | Lifecycle rules, retention policies |

## AT. Hospitality Operational Risks
| # | Risk | Mitigation |
|---|---|---|
| O1 | Front-desk adoption failure (slow UX, training gaps) | Early usability tests, keyboard workflows, training program, on-site go-live support |
| O2 | Cut-over from legacy/paper mid-stay | Opening-balance import, parallel run week, rollback plan |
| O3 | Staff fraud: voids after cash, unauthorised discounts/comps, room sold off-book | Immutable ledger, limits/approvals, cashier controls, exception reports, owner alerts |
| O4 | Night audit skipped/postponed ⇒ wrong date | Business-date banners, audit reminders, escalation, auto-audit (P2) |
| O5 | Overbooking without process (walking guests) | Oversold worklist, relocation workflow (P2), overbook limits default 0 |
| O6 | Internet/power outages | Contingency pack, degraded modes, UPS guidance |
| O7 | Rate/tax misconfiguration | Simulator, sign-off, audit, templates |
| O8 | OTA mapping errors ⇒ oversells (P2) | Mapping gate, dry-run, monitoring |
| O9 | Housekeeping status disagreement (rooms sold dirty) | Separate statuses, hard rules, mobile updates |
| O10 | Corporate credit exposure/unpaid AR | Limits, holds, aging alerts, statements |
| O11 | Guest complaints from bill errors | Pre-checkout review, dispute workflow, reversal trail |
| O12 | Data-entry duplication of guests | Dedup, ID search, merge tools |
| O13 | Multi-user concurrency at desk (two agents same booking) | ETag/optimistic locks, soft edit-locks/presence indicator |
| O14 | Seasonal peaks (Eid, wedding season) | Load tests, autoscaling, rate calendars |
| O15 | Reliance on WhatsApp confirmations w/o opt-in | Consent capture, template compliance (P2) |

## AU. Regulatory / Data Risks
*All items flagged **VERIFY** need confirmation with qualified Pakistani counsel/tax advisors before implementation; this document makes no legal assertions.*
| # | Topic | Concern |
|---|---|---|
| R1 | Personal data protection | Pakistan's data-protection legislation status (bill vs enacted) — **VERIFY**; design for GDPR-grade controls (consent, minimisation, access/erasure, breach notification, DPO role) |
| R2 | Data localisation / cross-border transfer | Possible restrictions on transferring certain personal data abroad — **VERIFY**; affects region choice (D-16), backups, SaaS subprocessors, AI providers |
| R3 | Guest registration duties | Hotels commonly must record guests' identity and may have to report guest data to police/authorities (provincial mechanisms, foreign-guest forms) — **VERIFY** per province; drives ID capture, retention, export formats; conflicts with minimisation ⇒ retention rules by law |
| R4 | Sales tax / service tax on hotel services | Provincial revenue authorities' regimes and rates differ; invoicing, registration, e-invoicing/POS integration mandates possible — **VERIFY**; tax engine must be configuration-driven |
| R5 | Withholding taxes | Corporate customers deduct WHT; certificate handling — **VERIFY** |
| R6 | Invoice format & numbering | Legal invoice content requirements, numbering — **VERIFY** |
| R7 | Payments regulation | State Bank of Pakistan rules for payment gateways/wallets/PSPs; whether platform may hold or route funds (**avoid becoming a payment intermediary**) — **VERIFY**; PCI DSS scope minimisation |
| R8 | Telecom messaging rules | PTA rules for SMS sender IDs/bulk messaging, DND; **WhatsApp Business** policy: opt-in, templates, prohibited content — **VERIFY** current terms |
| R9 | E-signature validity | Electronic signature/registration card legal weight — **VERIFY** (Electronic Transactions Ordinance context) |
| R10 | Guest identity processing | CNIC handling rules/sensitivity; NADRA verification access is restricted — do not assume |
| R11 | Marriage-certificate / local-couple policies | Some properties require documents from local couples; legally and ethically sensitive; make configurable, never platform-mandated, with explicit data minimisation |
| R12 | Foreign guest rules | Foreigner registration, visa data, currency rules for foreigners paying in foreign currency — **VERIFY** |
| R13 | Employee/labour data | Staff data (attendance in HK, performance metrics) — privacy/labour rules |
| R14 | Retention conflicts | Tax record retention vs erasure requests; anonymisation strategy |
| R15 | Intermediary/OTA terms | Data-sharing and parity clauses in OTA contracts |
| R16 | Sanctions/AML | If cash-heavy — cash reporting thresholds — **VERIFY** |
| R17 | Third-country processors | SES/SMS/WhatsApp/analytics/AI vendors as subprocessors; DPAs |
| R18 | Terms/contract | SaaS agreement, DPA, SLA, liability limits, data-ownership and export/exit clauses |
| R19 | Accessibility | Not currently mandated locally but a competitive/ethical expectation (WCAG 2.2 AA) |

---

## AV. Questions Requiring Stakeholder Decision

### Business & market
1. **Is Rabia Sanctuary the first pilot property** (repository name suggests so)? What size/type, and does it use OTAs, corporate accounts, cash-heavy operations?
2. Target for first 12 months: number of properties/rooms, segments (guesthouses vs mid-size hotels), cities?
3. Pricing philosophy: fixed per-room bands vs per-property vs commission; PKR price ceilings; annual prepay? Free tier/trial?
4. Sales model: direct, resellers, hotel associations? White-label demand?
5. Competitor set to benchmark (local Pakistani PMSs and international) — any incumbent migrations needed?
6. Team size, budget, and target dates? (drives sequencing)

### Product
7. Approve the **reservation state model** (GUARANTEED as attribute; INQUIRY as quote/lead)?
8. Approve **two mobile apps** decision (staff native in MVP; guest PWA first)?
9. Is **channel manager in MVP** a hard sales requirement for the pilot hotels? If yes, which single OTA and are we prepared for certification lead-times / aggregator route?
10. Must MVP include an **online payment gateway**? Which one(s) does the pilot use?
11. Is **WhatsApp click-to-chat** sufficient for MVP, or is official API automation mandatory at launch (requires Meta verification/BSP)?
12. Overbooking: default 0 (recommended)? Which properties need it and how do they handle "walking" guests?
13. Rate model specifics: dual pricing for local vs foreign guests? Weekend definition? Extra-person pricing norms? Tax-inclusive vs exclusive quoting convention in the market?
14. Cancellation/no-show norms and deposit rules to ship as templates?
15. Must MVP handle **hourly/day-use** stays and **per-bed** (dorm/hostel) sales?
16. Services: which operations (restaurant/laundry/transport) run *inside* PMS vs external POS in the pilot?
17. Preferred languages for staff UI at launch (English only vs Urdu)? Guest documents in Urdu?
18. Reporting: which management reports do owners actually look at today (share examples)? Any statutory reports?

### Legal/regulatory/finance
19. Confirm applicable **tax regimes** per pilot city/province, invoice formats, and any fiscal-integration mandate (engage tax advisor now).
20. Confirm **police/authority guest reporting** requirements and formats (per province), plus foreign guest forms.
21. Data protection posture: is a DPO/legal counsel engaged? Acceptable cross-border hosting? **AWS region choice** (UAE/Bahrain vs Mumbai; any customer constraints?).
22. Will the company handle funds (settlement to hotels) or only connect hotels' own merchant accounts? (Strongly recommend the latter.)
23. Corporate customers: standard payment terms, WHT handling expectations, credit-limit governance?

### Technical/organisational
24. Approve **identity build-vs-buy** (in-house behind interface vs managed IdP)?
25. Approve stack versions policy and **ORM choice** (Kysely/SQL-first)?
26. Data migration: which legacy systems/formats must be imported at pilots?
27. SLA promises for pilot (uptime, support hours, response times) and support staffing (Urdu/English)?
28. Will the platform provide hardware guidance/resale (tablets, signature pads, ID scanners, printers, UPS)?
29. Are there existing integrations/vendors mandated (POS, accounting like QuickBooks, SMS aggregator, lock vendor)?
30. Branding, domain names, and legal entity that will contract with customers?
31. Who owns product decisions day-to-day (single accountable product owner)?
32. Data retention defaults (ID images, guest profiles) you want to set as product defaults?
33. Which hotels will let us observe front-desk/night-audit/housekeeping operations for a week before UI freeze?
34. Appetite for early external security review/pen test and certification (ISO 27001/SOC 2) timelines for enterprise groups?
35. Success metrics for MVP (e.g., pilot NPS, time-to-first-booking, reduction in cash variance, audit completion time)?
