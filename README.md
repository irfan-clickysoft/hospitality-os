# Hospitality OS

Cloud hospitality operating system (PMS core; CRS, booking engine, channel manager, portals and apps to follow).
Architecture and product decisions: [`docs/phase-0/00-index.md`](docs/phase-0/00-index.md). Pilot: Sunset BnB (Boulevard, Creek, Ramna).

## Status — Phase 1, milestone M0 (foundations), slice 1
- Monorepo (pnpm + Turborepo, TypeScript strict)
- `@hos/db`: SQL-first migrations, PostgreSQL row-level security on every tenant table, runtime role without `BYPASSRLS`,
  append-only audit log, transactional outbox / inbox / idempotency tables, `withTenant()` transaction helper
- **Tenant-isolation test suite** (schema lint + behavioural RLS tests) — a CI gate
- `@hos/domain-types`: `Money` (bigint minor units, exact rounding/allocation; no floats)
- `@hos/api`: NestJS (Fastify) skeleton, health/readiness, tenant context

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
