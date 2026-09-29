# 08 — Decision Register (ADR-style)

Every significant technical recommendation in Phase 0, in the required format:
**RECOMMENDATION · WHY · ALTERNATIVES · TRADE-OFF · FUTURE IMPACT.**
IDs (D-01…) are referenced from other documents.

---

## D-01 Tenancy model: shared database, shared schema, `tenant_id` everywhere, enforced by PostgreSQL Row-Level Security

- **RECOMMENDATION.** One PostgreSQL cluster, one schema. Every tenant-owned table carries `tenant_id NOT NULL`. `FORCE ROW LEVEL SECURITY` on all of them with a policy `tenant_id = current_setting('app.tenant_id')::uuid`. The API's DB role is a non-owner without `BYPASSRLS`. Each request runs in a transaction that begins with `SET LOCAL app.tenant_id = …`. Composite foreign keys `(tenant_id, id)` make cross-tenant references structurally impossible. Enterprise tenants may later be moved to a dedicated database ("silo") with the same schema; the app resolves a tenant → connection pool via a tenant directory.
- **WHY.** Thousands of small Pakistani properties must be economical to serve. A DB per tenant is operationally expensive at that scale (migrations × N). RLS gives a defence-in-depth net *below* application code, so a forgotten `WHERE tenant_id=` becomes an empty result instead of a breach.
- **ALTERNATIVES.** (a) Schema-per-tenant; (b) DB-per-tenant; (c) app-level filtering only; (d) hybrid pooled + silo (chosen as the future path).
- **TRADE-OFF.** RLS adds planner overhead (mitigated by leading `tenant_id` on every index) and needs discipline with pooling (use `SET LOCAL` inside transactions; PgBouncer transaction mode is compatible). Migrations run as a privileged role; background jobs must also set tenant context. Noisy-neighbour risk is real and handled by per-tenant rate limits and quotas.
- **FUTURE IMPACT.** Silo option satisfies large-group/regulatory demands. Partitioning big tables (postings, audit, channel events) by time and hash(tenant) is possible later without model change.

## D-02 Modular monolith (NestJS), with enforced module boundaries

- **RECOMMENDATION.** One deployable API + one worker deployable (same codebase, different entrypoint). Modules communicate through explicit public service interfaces and domain events only; no cross-module table access. Boundaries enforced in CI (dependency-cruiser / ESLint boundaries rule). Each module owns its tables (table-name prefix per module).
- **WHY.** A small team must ship. Microservices multiply operational cost and distributed-transaction risk exactly where hospitality needs strong consistency (inventory + folio + payment).
- **ALTERNATIVES.** Microservices; serverless functions; Rails/Django/.NET.
- **TRADE-OFF.** One blast radius, one scaling unit (mitigated by splitting *workers* by queue). Discipline needed to avoid a "big ball of mud".
- **FUTURE IMPACT.** Extraction order if ever needed: Channels (highest volume, spiky) → Notifications → Reports → Payments webhooks ingress. Because they already communicate via outbox events and own their tables, extraction is a deployment change, not a redesign.

## D-03 SQL-first persistence (typed query builder, hand-written migrations), not a heavyweight ORM

- **RECOMMENDATION.** Kysely (or Drizzle) with generated types, plus SQL migrations (Atlas/dbmate/node-pg-migrate). Repositories are thin; business invariants live in domain services *and* DB constraints.
- **WHY.** We need `EXCLUDE USING gist`, RLS policies, partial unique indexes, triggers preventing UPDATE/DELETE on ledgers, `daterange` types, `SELECT … FOR UPDATE`, conditional atomic updates. ORMs (Prisma/TypeORM) support these poorly or only via raw SQL, which defeats their purpose.
- **ALTERNATIVES.** Prisma (best DX, weakest Postgres-specific features), TypeORM (mature, leaky), MikroORM.
- **TRADE-OFF.** More SQL literacy required; less scaffolding.
- **FUTURE IMPACT.** Schema is a first-class artefact — reviewable, portable, and usable for the data warehouse.

## D-04 Money = integer minor units + ISO-4217 currency; tax computed by a rules engine; never floats

- **RECOMMENDATION.** `amount_minor BIGINT` + `currency CHAR(3)`; currency exponent from a reference table (PKR=2, but future JPY=0, KWD=3). Intermediate calculations in a decimal library (decimal.js / big.js) using property-configured rounding (line-level vs invoice-level). Rate cards may store higher precision (`NUMERIC(19,6)`) *before* rounding; postings are always rounded minor units. Postings snapshot tax rate and rule id.
- **WHY.** Floating point causes penny drift; multi-currency is guaranteed to arrive.
- **ALTERNATIVES.** `NUMERIC(19,4)` everywhere (simpler reads, but rounding ambiguity and exponent mistakes).
- **TRADE-OFF.** Formatting helpers everywhere; ETL must know exponent.
- **FUTURE IMPACT.** Multi-currency needs only FX rate tables and dual-amount postings (`amount`, `base_amount`, `fx_rate_id`) — columns reserved now.

## D-05 Availability: two-tier control — room-type night counters + physical-room exclusion constraint

- **RECOMMENDATION.**
  1. `inventory_day(tenant, property, room_type, business_date)` counters (`physical`, `out_of_order`, `blocked`, `reserved`, `held`, `overbook_limit`) mutated with an **atomic conditional UPDATE** (`… SET reserved = reserved + :n WHERE reserved + held + :n <= sellable - blocked + overbook_limit RETURNING …`) inside the booking transaction. Multi-night bookings update rows in date order to avoid deadlocks; all-or-nothing.
  2. Assigned physical rooms are protected by `EXCLUDE USING gist (room_id WITH =, stay_range WITH &&) WHERE (status active)` on `room_assignment`, where `stay_range` is a `daterange` `[arrival, departure)` in property-local dates.
  3. Nightly and on-demand **invariant checker** recomputes counters from source rows and alerts on drift.
- **WHY.** Counters give O(1) availability for search and the booking engine; the exclusion constraint makes double-assignment of a physical room impossible even if application logic is wrong; the checker catches everything else. The visual calendar is never trusted — every drag/drop is a server command.
- **ALTERNATIVES.** (a) Compute availability by counting reservations on each query (correct but slow for groups/CRS); (b) Redis-based counters (fast but second source of truth — rejected); (c) serializable isolation only (retry storms on hot dates).
- **TRADE-OFF.** Counter maintenance must be in the same transaction as every state change touching inventory (create, modify, cancel, no-show, OOO, blocks). Centralised in one `InventoryService`; no other module may write counters.
- **FUTURE IMPACT.** Same counters feed channel ARI pushes (via outbox event `InventoryChanged`), the booking engine and CRS. Group blocks fit as `blocked` with release schedules.

## D-06 Reservation lifecycle: `GUARANTEED` is an attribute, not a state; `INQUIRY` is not an inventory-holding reservation

- **RECOMMENDATION.** Header states: `OPTION` (holds inventory, has `expires_at`), `CONFIRMED`, `CHECKED_IN`, `CHECKED_OUT`, `CANCELLED`, `NO_SHOW`, plus `WAITLISTED` and `PENDING_APPROVAL` (corporate). `guarantee_type` (`NONE`, `DEPOSIT`, `CARD`, `COMPANY`, `OTA_PREPAID`, …) is orthogonal. `INQUIRY`/quote lives in a `lead`/`quote` object (Sales), converting into a reservation. `TENTATIVE` merged into `OPTION`. Per-room progress is tracked on `reservation_room` / `stay` (a family can check in one room and not the other); header status is derived from children.
- **WHY.** Industry PMS systems (Opera-style) separate booking status from guarantee. Making `GUARANTEED` a state forces illegal combinations (a guaranteed reservation that is also checked-in) and breaks no-show/deposit-forfeiture rules.
- **ALTERNATIVES.** The requested flat 9-state list.
- **TRADE-OFF.** Slightly more concepts for UI to explain; far fewer invalid states.
- **FUTURE IMPACT.** OTA prepaid vs pay-at-property, corporate credit guarantee, and deposit policies all attach to `guarantee_type` without touching the state machine.

## D-07 Folio = immutable posting ledger; balances are derived; corrections by reversal

- **RECOMMENDATION.** `folio_posting` is append-only (DB triggers + revoked UPDATE/DELETE on app role). Types: `CHARGE`, `TAX`, `PAYMENT`, `ADJUSTMENT`, `REVERSAL`, `TRANSFER_OUT/IN`, `DEPOSIT_APPLY`. Each posting has `business_date`, `txn_code`, signed amount, `reverses_posting_id`, `transfer_group_id`, `idempotency_key`, `cashier_session_id`. Materialised `folio_balance` row updated in the same transaction (with a nightly recompute check). Invoices are separate, immutable, gapless-numbered documents; corrections via credit notes.
- **WHY.** Audits, tax authorities and disputes demand a full trail. "Total bill" fields cause the classic revenue-leakage and "the number changed" problems.
- **ALTERNATIVES.** Mutable line items with audit log; full double-entry GL inside the PMS.
- **TRADE-OFF.** Reports need to net reversals; UI must present reversal pairs clearly.
- **FUTURE IMPACT.** Each posting maps through `txn_code → ledger_account` (mapping table), giving a clean feed to QuickBooks/Xero/SAP later without a rewrite.

## D-08 Business date is a first-class property attribute; no back-posting into closed dates

- **RECOMMENDATION.** `property.business_date` advanced only by Night Audit. All operational timestamps are `timestamptz` (UTC) + property timezone; all business/accounting dates are `date`. Postings to a closed date are rejected; corrections post to the current business date with a reference to the original.
- **WHY.** Hotels operate past midnight; a 2 AM check-in belongs to the previous business day.
- **ALTERNATIVES.** Derive date from timestamp (wrong for late arrivals); allow back-posting (destroys report immutability).
- **TRADE-OFF.** Users must understand "business date ≠ today"; UI always shows it prominently.
- **FUTURE IMPACT.** Enables immutable daily statistics snapshots and trustworthy revenue history.

## D-09 Events: transactional outbox in PostgreSQL + BullMQ relay + idempotent inbox; no Kafka in MVP

- **RECOMMENDATION.** Domain services write `outbox_event` in the same transaction as state change. A relay publishes to BullMQ queues; consumers de-duplicate through an `inbox` table `(consumer, event_id)`. Events are versioned, tenant-tagged JSON.
- **WHY.** Guarantees "state changed ⇔ event will be delivered at least once" without distributed transactions. Volume (thousands of events/hour) is far below Kafka territory.
- **ALTERNATIVES.** Kafka/Kinesis/SNS+SQS; in-process EventEmitter only (loses events on crash).
- **TRADE-OFF.** At-least-once delivery ⇒ every consumer must be idempotent. Redis is a critical dependency (see D-15).
- **FUTURE IMPACT.** Outbox can be re-pointed at SNS/SQS or Kafka without touching producers; channel-manager extraction rides on this.

## D-10 REST + OpenAPI now; typed clients generated; idempotency keys on all critical writes

- **RECOMMENDATION.** NestJS controllers with Zod schemas → OpenAPI 3.1 → generated TS client (`packages/api-client`). Cursor pagination, RFC 9457 `application/problem+json` errors, `Idempotency-Key` header stored in `idempotency_key` table for 24–72h (request hash + response). Optimistic concurrency with `ETag`/`If-Match` (`version` column) on reservation, folio, rate edits.
- **WHY.** Partners (OTAs, POS, corporate ERPs) need REST/webhooks; mobile networks retry.
- **ALTERNATIVES.** GraphQL (flexible for dashboards, harder to authorize/rate-limit per field); tRPC (fast, but couples clients and is unsuitable for a public API).
- **TRADE-OFF.** More endpoints than GraphQL; mitigated by composite "view" endpoints (e.g., rack).
- **FUTURE IMPACT.** Public API and webhooks for third-party developers come nearly free.

## D-11 Identity: build in-house Identity module behind an interface (Cognito/WorkOS remain fallbacks)

- **RECOMMENDATION.** In-house: Argon2id, TOTP + WebAuthn (passkeys), server-side sessions (web, httpOnly/SameSite cookies) and short-lived access + rotating refresh tokens (mobile). Separate identity *realms*: `platform`, `tenant_staff`, `corporate`, `guest`. Authorization always server-side via RBAC with scoped role assignments.
- **WHY.** Our authz model (scope = tenant/legal entity/property/department; limits like max discount) is domain-specific; the auth *primitives* are the easy part. Also avoids per-MAU pricing on a low-ARPU market.
- **ALTERNATIVES.** AWS Cognito (cheap, awkward customization/migration), Auth0/Clerk/WorkOS (fast, costly at scale, data residency questions).
- **TRADE-OFF.** Security-critical code we own; requires external pen-test and strict library use.
- **FUTURE IMPACT.** OIDC/SAML SSO for enterprise tenants added in Phase 2/3 through the same interface.

## D-12 Mobile: two apps, one Expo monorepo with shared packages; staff app in MVP, guest native app in Phase 2

- **RECOMMENDATION.** `apps/mobile-staff` (housekeeping, maintenance, later transfers/F&B) and `apps/mobile-guest` (Phase 2) as **separate Expo apps** sharing `packages/ui-native`, `api-client`, `domain-types`, `i18n`. MVP guest experience = mobile-first **web/PWA** (`guest-web`) reached via WhatsApp/SMS/email links.
- **WHY / trade-off matrix.**

| Dimension | One app (role-switching) | Two apps (recommended) |
|---|---|---|
| Store listing & branding | One generic listing; can't white-label per hotel | Guest app can be branded/white-labelled later |
| Security surface | Guest binaries contain staff code paths | Staff app can enforce MDM/device policy, MFA, root detection |
| Release cadence | Coupled — staff hotfix waits for store review of guest features | Independent |
| Install friction | Guests download an "everything" app | Small, focused guest app |
| Dev cost | Lower (one shell) | Slightly higher, mitigated by shared packages |
| Offline needs | Mixed | Staff app needs SQLite queue; guest app doesn't |

- **ALTERNATIVES.** Single app; native Swift/Kotlin; Flutter.
- **FUTURE IMPACT.** Guests rarely install an app for a 1–2-night stay ⇒ PWA-first is commercially right for Pakistan (WhatsApp deep links, low storage phones).

## D-13 Web: Next.js apps sharing a design system; staff web app is an SPA-style client with server-verified data

- **RECOMMENDATION.** `hotel-web` (PMS), `corporate-portal`, `guest-web` (booking engine + pre-check-in + guest portal), `admin` (platform back office). Next.js App Router for shell/SSR of public pages (booking engine SEO); heavy operational screens (rack, folio) are client-rendered with TanStack Query + virtualized grids. Tailwind + Radix primitives in `packages/ui`.
- **WHY.** Operational speed depends on client-side interactivity and keyboard handling; public pages need SSR/SEO.
- **ALTERNATIVES.** Vite SPA for PMS; Remix.
- **TRADE-OFF.** Two rendering modes to reason about.
- **FUTURE IMPACT.** Booking engine embeddable as iframe/web component from the same codebase.

## D-14 Channel Manager: adapter pattern, raw-event store, mapping gate, quarantine — and **defer to Phase 2**, possibly via aggregator first

- **RECOMMENDATION.** Ports & adapters: `ChannelProvider` interface (`pushAvailability/Rates/Restrictions`, `pullReservations`, `handleWebhook`, `verifyMapping`). Inbound events land in immutable `channel_event` store first, then are normalised and applied idempotently. MVP builds the abstraction, `Channel/Source` tracking and manual reservation entry only. Begin partner/certification applications during MVP because lead times are long. Phase 2 sequence: (1) iCal read/write bridge for guesthouses (low fidelity, clearly labelled), (2) Booking.com, (3) Agoda, (4) Airbnb/Expedia subject to partner access. Evaluate a certified channel-manager aggregator API as a faster path to many OTAs vs. direct certification.
- **WHY.** OTA connectivity requires approved partner status and certification with provider-specific requirements that **must be verified against current provider documentation** (see 04 §X.9). Building it before the core is stable would import overbooking risk into an immature inventory engine.
- **ALTERNATIVES.** Full CM in MVP; resell third-party CM only.
- **TRADE-OFF.** Hotels using OTAs must use their existing channel manager or manual updates in MVP — a real sales objection; mitigated by targeting direct/corporate/walk-in-heavy segments first and by the iCal bridge.
- **FUTURE IMPACT.** Extractable service; reconciliation module builds on the same event store.

## D-15 Redis/BullMQ is treated as *non-authoritative* infrastructure

- **RECOMMENDATION.** PostgreSQL remains the system of record for jobs that matter (outbox, sync jobs, night-audit steps). Redis holds queues, rate-limit counters, short-lived caches, locks-for-efficiency only (never for correctness). ElastiCache configured `noeviction`, Multi-AZ, persistence enabled for queue instance; separate instance for cache.
- **WHY.** Losing Redis must delay work, not lose or duplicate money/inventory.
- **ALTERNATIVES.** Postgres-based queue (pg-boss) — attractive at small scale; SQS.
- **TRADE-OFF.** Two places to look during incident triage.
- **FUTURE IMPACT.** Swappable to SQS with the outbox relay as the seam.

## D-16 AWS region: prefer UAE (`me-central-1`) or Bahrain (`me-south-1`) over Mumbai, pending stakeholder/legal input

- **RECOMMENDATION.** Deploy primary in a Middle-East region if required services are available; Mumbai as latency-friendly fallback. Confirm current service availability and data-localisation obligations before choosing.
- **WHY.** No AWS region in Pakistan. Latency from Karachi/Lahore to Gulf and Mumbai is comparable; Pakistani customers and regulators may be uncomfortable with Indian-hosted guest data given political sensitivities; a draft data-protection regime (status to be verified) may restrict cross-border transfer of some categories.
- **ALTERNATIVES.** Mumbai; Singapore; a local Pakistani data centre/co-lo (limited managed services); hybrid.
- **TRADE-OFF.** Newer regions can lack some services and have higher cost.
- **FUTURE IMPACT.** Region-per-tenant deployment ("cells") is possible later for residency-bound enterprise clients.

## D-17 Offline strategy: degrade gracefully, don't sync-fight — tiered by workflow risk

- **RECOMMENDATION.** MVP: (1) *Contingency pack* — automatically generated arrivals / in-house / room-status / folio-balance PDFs cached on front-desk devices and emailed each hour/at audit; printable registration cards; (2) housekeeping/maintenance mobile app with a local queue of idempotent status updates; (3) clear "degraded mode" banner. Phase 2: front-desk read-only offline (PWA cache) + manual "paper-to-system" backfill screens with reason codes. Phase 3: local edge node for large hotels if demand proves it.
- **WHY.** Offline *writes* to inventory or money create conflicts that are worse than downtime. Housekeeping updates are commutative-ish and safe to queue.
- **ALTERNATIVES.** Full local-first sync (CRDT/PouchDB) — huge complexity.
- **TRADE-OFF.** Front desk cannot create bookings offline in MVP; must fall back to paper procedure.
- **FUTURE IMPACT.** Load-shedding and unstable ISP links in Pakistan make this a sales differentiator worth investing in incrementally.

## D-18 Payments: hosted-fields/redirect tokenisation only; SAQ-A posture; adapter per provider

- **RECOMMENDATION.** The platform never sees or stores PAN/CVV. `PaymentProvider` port with `createIntent`, `authorize`, `capture`, `void`, `refund`, `parseWebhook`, `reconcile`. Webhook ingestion: verify signature → store raw → dedupe `(provider, event_id)` → transition → post to folio, all in one transaction. Manual methods (cash, bank transfer, offline POS slip) are first-class `payment` records with verification states.
- **WHY.** Minimises PCI scope; isolates gateway churn (Pakistani gateways vary widely in API maturity).
- **ALTERNATIVES.** Store tokens+PAN in vault (PCI SAQ-D — no).
- **TRADE-OFF.** Card-present terminals run outside the system in MVP (staff records slip reference/RRN).
- **FUTURE IMPACT.** Settlement files → automated reconciliation module.

## D-19 Night audit as a durable, resumable, step-ledgered workflow

- **RECOMMENDATION.** `night_audit_run` with per-step `night_audit_step` rows (idempotent, checkpointed). Unique `(property_id, business_date)` for a completed run. Room-charge postings protected by unique `(stay_night_id, txn_code)`. Roll-forward is the last step and is atomic. Runs can be resumed after failure; never "rolled back" — mistakes are corrected via adjustments on the new date.
- **WHY.** Mission-critical; failure halfway through must not double-charge or leave the property in limbo.
- **ALTERNATIVES.** Single big transaction (locks the property; timeouts); cron-only automatic audit (loses exception review).
- **TRADE-OFF.** More tables/state to model.
- **FUTURE IMPACT.** Optional *auto-audit* for small properties with exceptions routed to a manager (Phase 2).

## D-20 Audit: append-only, monthly-partitioned `audit_log`, plus separate `data_access_log` for PII reads

- **RECOMMENDATION.** Structured before/after JSON diffs, actor (user/API client/system/impersonator), reason code, request id, IP/device. Optional hash-chain per tenant for tamper evidence. Separate access log for sensitive reads (ID documents, full CNIC). Retention configurable; exportable to S3 (Object Lock) nightly.
- **WHY.** Hospitality fraud is often staff-driven (comps, voids, cash). Reads of ID documents are themselves regulated events.
- **ALTERNATIVES.** Event-sourcing the whole system (overkill); app logs only.
- **TRADE-OFF.** Storage growth ⇒ partitioning and archive tiers.
- **FUTURE IMPACT.** Feeds anomaly detection (Phase 3).

## D-21 Reporting: OLTP reads + immutable daily snapshots in MVP; warehouse in Phase 3

- **RECOMMENDATION.** Night audit writes `daily_property_stats` and `daily_revenue_by_dimension` snapshot tables (never recomputed retroactively). Live dashboards query indexed OLTP (read replica when needed). Async report exports via workers to S3. Phase 3: replicate to a columnar store (Athena/ClickHouse/Redshift) for analytics/AI.
- **WHY.** Historical reports must not change when a rate plan is later edited.
- **ALTERNATIVES.** Warehouse first; materialised views.
- **TRADE-OFF.** Snapshot schema must anticipate dimensions (source, channel, segment, rate plan, room type).
- **FUTURE IMPACT.** AI/NL-reporting queries the warehouse through a governed semantic layer with tenant-scoped credentials.

## D-22 Feature entitlements are runtime data, not code branches

- **RECOMMENDATION.** `subscription_feature` → materialised `tenant_entitlement` (boolean/limit). Checked server-side by a guard; UI hides but never enforces. Suspension = read-only + night audit still permitted (never lock a hotel out mid-stay).
- **WHY.** Pricing will change constantly; a hotel with in-house guests must not be bricked by a failed subscription payment.
- **ALTERNATIVES.** Hardcoded plan tiers.
- **TRADE-OFF.** Entitlement caching/invalidations.
- **FUTURE IMPACT.** Supports add-ons, trials, custom enterprise deals, marketplace integrations.

## D-23 Monorepo tooling: pnpm + Turborepo; contract-first packages

- **RECOMMENDATION.** As suggested, plus: `packages/domain-types` (Zod schemas as single source), `packages/validation`, `packages/api-client` (generated), `packages/auth` (permission constants shared with server for UI hints only), `packages/i18n`, `packages/ui`, `packages/config` (tsconfig/eslint), and `packages/testing` (fixtures, tenant-isolation harness). Add `infra/` (Terraform) and `docs/`.
- **WHY.** Types and permission names shared, enforcement server-only.
- **ALTERNATIVES.** Nx; polyrepo.
- **TRADE-OFF.** Remote-cache setup needed for CI speed.
- **FUTURE IMPACT.** Clear seams for extracting services later.
