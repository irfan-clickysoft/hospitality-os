# Hospitality OS

Cloud hospitality operating system (PMS core; CRS, booking engine, channel manager, portals and apps to follow).
Architecture and product decisions: [`docs/phase-0/00-index.md`](docs/phase-0/00-index.md). Pilot: Sunset BnB (Boulevard, Creek, Ramna).

## Status — Phase 1, milestone M0 (foundations)
**Slice 1:** monorepo; `@hos/db` (SQL migrations, forced RLS on every tenant table, `withTenant()`); tenant-isolation suite (schema lint + RLS tests, CI gate); `@hos/domain-types` `Money`; API skeleton.
**Slice 2 (this):**
- `@hos/auth`: pure authorization engine — scoped grants (tenant / legal entity / property / department), validity windows, limits (discount, refund, adjustment) that yield *approval required*, and **privilege-escalation guards** for role assignment; system role templates
- API: global permission guard (**deny by default**; every route must declare a permission or be explicitly `@Public`, enforced by a contract test), tenant middleware + correlation ids, RFC 9457 problem+json errors, 404-not-403 for foreign resources
- Audit service (same-transaction, redacting), **transactional outbox** + relay (ordered per aggregate, retry, dead-letter, safe with concurrent relays), idempotent inbox, **idempotency keys** (exactly-once under concurrency)
- Tenant provisioning (roles seeded per tenant, owner, audit + `TenantCreated` event)
**Slice 3 (identity):** invitation → password (Argon2id, length-first policy), login with lockout and non-enumerating errors, server-side sessions (hashed opaque tokens in `__Host-` cookies, idle + absolute expiry), CSRF token + Origin allow-list, TOTP two-factor (RFC 6238, encrypted seeds, replay protection, recovery codes), **step-up MFA for sensitive permissions**, password change with session revocation, staff language preference (English / Urdu), audit-log read endpoint.
Not yet: observability, Terraform, i18n scaffolding, first business modules (rooms, rates, availability).

## Local setup
Requires Node 22, pnpm 10, PostgreSQL 16 with `btree_gist`, `pgcrypto`, `pg_trgm`, `citext`.
```bash
pnpm install
bash scripts/bootstrap-db.sh        # roles hos_owner / hos_app / hos_admin + databases (dev passwords only)
cp .env.example .env
pnpm db:migrate                      # uses DATABASE_URL_OWNER
pnpm typecheck && pnpm test
```
Set `PGSUPERUSER_URL` if you are not using a local `postgres` OS user.

## Rules that are enforced in code review and CI
1. Every tenant-owned table has `tenant_id`, forced RLS and a policy; the lint in `packages/db/test/schema-lint.test.ts` fails otherwise.
2. Tenant data is accessed only through `TenantDb.tx()` / `withTenant()`; the tenant comes from the authenticated principal, never from client input.
3. Money is `Money` (integer minor units). Never `number` for amounts.
4. Ledgers (`audit_log`, future `folio_posting`) are append-only: no UPDATE/DELETE.
5. No secrets in the repository; production credentials come from AWS Secrets Manager.
