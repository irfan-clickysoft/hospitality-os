# Hospitality Operating System — Phase 0: Discovery & Product Architecture

**Status:** DRAFT FOR STAKEHOLDER APPROVAL · **No application code exists or will be written until approval.**
**Scope of this package:** architecture, product definition, and decisions only.

## Document map
| File | Contents | Brief refs |
|---|---|---|
| `00-index.md` (this) | Executive summary, challenges to the brief, traceability, approval request | — |
| `01-product-business-org.md` | Vision, SaaS model, hierarchy, personas, RBAC, feature inventory with MVP/P2/P3 classification | A–F |
| `02-journeys-and-workflows.md` | Onboarding, reservation, walk-in, corporate, pre-check-in, check-in, stay, service, checkout, housekeeping, maintenance | G–Q |
| `03-money-and-core-domains.md` | Folio, payments, cashier, night audit, corporate AR, **state machines** | R–V |
| `04-platform-and-channels.md` | Availability engine, rate engine, CRS, channel manager, booking engine, guest/staff apps, back office, reporting | W–AC |
| `05-technical-architecture.md` | System/domain architecture, **ERD**, API, events/jobs, integrations | AD–AI |
| `06-security-infra-ops.md` | Security & tenant isolation, AWS, DR, observability, i18n, offline, performance, testing | AJ–AM |
| `07-scope-roadmap-risks.md` | MVP scope/exclusions, Phase 2/3, dev sequence, risks, **35 open questions** | AN–AV |
| `08-decision-register.md` | 23 ADRs in RECOMMENDATION / WHY / ALTERNATIVES / TRADE-OFF / FUTURE IMPACT format | all |

### Traceability to the 42-item Phase 0 list
1 Executive definition → 01 §A.1 · 2 Business model → 01 §B · 3 Tenant model → 01 §C · 4 Hierarchy → 01 §C · 5 Personas → 01 §D · 6 Roles → 01 §E.2 · 7 RBAC matrix → 01 §E.3–E.6 · 8 Feature inventory → 01 §F · 9 Property setup → 02 §G · 10 Reservation lifecycle → 02 §H + 03 state machine · 11 Check-in → 02 §L · 12 Checkout → 02 §O · 13 Guest lifecycle → 02 §M · 14 Corporate lifecycle → 02 §J + 03 §V · 15 Housekeeping → 02 §P · 16 Maintenance → 02 §Q · 17 Service request → 02 §N · 18 Folio → 03 §R · 19 Payment → 03 §S · 20 Cashier → 03 §T · 21 Night audit → 03 §U · 22 OTA/Channel → 04 §X · 23 Subscription → 01 §B.4 · 24 System architecture → 05 §AD · 25 Domains → 05 §AE · 26 ERD → 05 §AF · 27 API → 05 §AG · 28 Events → 05 §AH · 29 Integrations → 05 §AI · 30 Security → 06 §AJ · 31 AWS → 06 §AK · 32 Mobile → 04 §Z–AA + D-12 · 33 Web → 05 §AD.3 · 34 Back-office → 04 §AB · 35 Reporting → 04 §AC · 36 MVP → 07 §AN · 37 Phase 2 → 07 §AP · 38 Phase 3 → 07 §AQ · 39 Technical risks → 07 §AS · 40 Operational risks → 07 §AT · 41 Regulatory/data risks → 07 §AU · 42 Open questions → 07 §AV.

---

## Executive Summary

**What we're building.** A multi-tenant hospitality SaaS whose core is a PMS with integrity guarantees hotels can trust: concurrency-safe inventory, immutable folio ledger, idempotent night audit, and hard tenant isolation. It starts with independent Pakistani hotels/B&Bs (cash-heavy, corporate-credit-heavy, WhatsApp-native, connectivity-challenged) and is architected so the same product scales to multi-property groups.

**How we're building it.** TypeScript monorepo (pnpm/Turborepo); NestJS **modular monolith** with enforced module boundaries; PostgreSQL as the system of record with RLS, exclusion constraints, and append-only ledgers; transactional outbox → BullMQ for everything reactive; Next.js web apps; Expo mobile; AWS on ECS Fargate/RDS/ElastiCache/S3 via Terraform. Every third party (payments, OTAs, messaging, locks, ERP) sits behind a port/adapter so hotels never depend on any provider being online.

**The MVP** is the *operational core*: setup wizard → inventory/rates/availability → reservations + rack → front desk/check-in/out → folio/payments/cashier → housekeeping/maintenance → night audit/reports → corporate accounts (AR + basic portal) → RBAC/audit → minimal back office. **Distribution (channel manager, booking engine, OTAs), guest automation (pre-check-in, WhatsApp API, digital keys), AI and revenue management are Phase 2/3.** Estimated pilot-ready ≈ month 7–8 and GA ≈ month 10–12 with a ~10–12 person team (planning-grade estimate).

---

## Where I challenge the brief (and why)

| # | Brief says | Challenge / recommendation | Ref |
|---|---|---|---|
| 1 | Reservation states include GUARANTEED, TENTATIVE, INQUIRY as states | *Guarantee is an attribute*, not a lifecycle state; TENTATIVE≈OPTION (inventory hold with expiry); INQUIRY is a quote/lead that holds no inventory. Add WAITLISTED and PENDING_APPROVAL. Track status per **room line**, derive header status. | D-06 |
| 2 | Separate occupancy and housekeeping room statuses | Agreed; go further: store only VACANT/OCCUPIED/OOO/OOS; **derive** RESERVED/DEPARTING; DND is a *flag*. Fewer stored states ⇒ fewer stale-state bugs. | 02 §P |
| 3 | Channel manager & OTAs early | Provider access is gated by partner programs/certification we don't control. Build abstraction now, **start partner applications during MVP**, ship iCal bridge then first certified OTA in Phase 2; evaluate aggregator. I make no OTA API claims that must be verified. | D-14, 04 §X.9 |
| 4 | Guest & staff mobile apps | Guests rarely install apps for 1–2 nights; **guest = PWA via WhatsApp link first**; staff app (HK/maintenance) is the native app in MVP; separate apps, shared packages. | D-12 |
| 5 | Full offline consideration | Offline *writes* to inventory/money create worse problems than downtime. Tiered degraded modes; contingency pack in MVP. Power/ISP instability makes this a differentiator. | D-17 |
| 6 | Night audit "not just a date change" | Agreed; specified as durable, step-ledgered, resumable workflow with DB-level idempotency and compare-and-set roll; **no rollback**, only forward adjustments; no back-posting to closed dates. | D-19, D-08 |
| 7 | Hard-code no Pakistan tax | Agreed; jurisdiction packs. But **tax/e-invoicing/guest-reporting obligations must be validated by advisors before MVP freeze** — they are schedule risks. | 07 §AU |
| 8 | Guest account across properties | Identity platform-wide, **profile data tenant-scoped** with consent links; otherwise tenant isolation is violated. | 01 §C.1 |
| 9 | Corporate AR separate from folios | Yes; plus **WHT (withholding) at source** handling, or AR won't reconcile in Pakistan. | 03 §V |
| 10 | Payment methods list | Add **bank-transfer proof verification** (deposits via WhatsApp screenshots are dominant and a fraud vector) — in MVP. | 01 §F.15 |
| 11 | WhatsApp via approved APIs | Correct, but Meta verification/BSP/templates take time. MVP uses **click-to-chat deep links**; API automation in Phase 2. | 01 §F.1, 07 |
| 12 | Subscription pricing by rooms | Define billable rooms as ACTIVE rooms, peak-of-period w/ grace; and **never lock out a hotel with in-house guests** on non-payment (read-only + audit allowed). | D-22, 01 §B |
| 13 | Availability concurrency-safe | Specified as atomic counters + exclusion constraint + invariant checker; AND an explicit **OOO-creates-oversell resolution workflow** (silent cancellation never allowed). | D-05, 02 §Q |
| 14 | Many modules listed | MVP explicitly excludes ~30 items; every feature classified M/P2/P3. | 01 §F, 07 §AO |
| 15 | AWS target | No Pakistan region. Prefer Middle-East region over Mumbai pending legal/customer input; latency and data-sovereignty implications. | D-16 |
| 16 | Kafka/microservices avoided | Agreed, with outbox and extraction seams (Channels first). | D-02, D-09 |

## Missing workflows I added
Bank-transfer proof verification · WHT-aware receivables · guest/authority registration export · comp/house-use approvals · deposit forfeiture posting · overbooking "walk" workflow · pre-auth expiry tracking · key issuance log · oversold worklist · guest merge · data export/offboarding · contingency (downtime) pack · opening-balance import · support-access grants · idempotency and invariant-checker jobs.

## Top failure modes and where they're addressed
| Failure | Primary defence |
|---|---|
| **Overbooking** | D-05 atomic counters + EXCLUDE constraint + mapping gate + invariant checker; OTA inbound never silently dropped |
| **Revenue leakage** | Immutable ledger, limits/approvals, cashier blind close, comps/discount reports, checkout-with-balance controls, night audit exceptions |
| **Accounting discrepancies** | Posting snapshots (tax/rate/policy), business-date lock, gapless invoices, reconciliation checks, txn_code→ledger mapping |
| **Guest dissatisfaction** | Quote→book consistency, accurate policies, pre-checkout review, dispute workflow, room-ready comms |
| **Security breach** | RLS + layered isolation tests, encrypted IDs with access reasons, MFA/step-up, SAQ-A, server-side authz only |
| **Operational failure** | Contingency pack, degraded modes, resumable audit, provider-independent core |

---

## Approval request

Phase 0 is complete and **I have stopped here**. Before any Phase 1 implementation I need:

1. **Approve / amend** the ADRs in `08-decision-register.md` — especially D-06 (reservation model), D-12 (mobile), D-14 (channel sequencing), D-16 (AWS region), D-11 (identity build vs buy).
2. **Approve / amend the MVP boundary** in `07 §AN–AO`, including whether any excluded item (e.g., a specific OTA, online gateway, official WhatsApp API) is a hard launch requirement.
3. **Answer the 35 questions** in `07 §AV` — the highest-leverage ones: pilot property (Q1), OTA-in-MVP (Q9), payment gateway (Q10), tax/police-reporting confirmation (Q19–20), hosting region (Q21), team/timeline (Q6).
4. **Confirm engagement of Pakistani tax/legal advisors** to start immediately (parallel track).

On approval, Phase 1 begins with **M0 Foundations** (monorepo, CI/CD, Terraform baseline, tenancy + RLS + isolation-test harness, identity/RBAC/audit/outbox) — see `07 §AR`.
