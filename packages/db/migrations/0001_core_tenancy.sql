-- 0001 Core tenancy, identity/RBAC, audit, outbox, idempotency.
-- Conventions: uuid PKs; tenant_id on every tenant-owned table; composite (tenant_id,id) uniques for tenant-consistent FKs;
-- RLS ENABLED + FORCED with policy tenant_id = current_tenant_id(). hos_app has no BYPASSRLS.

CREATE FUNCTION current_tenant_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT NULLIF(current_setting('app.tenant_id', true), '')::uuid $$;

CREATE FUNCTION prevent_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed (append-only table)', TG_OP, TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;

-- Platform-level table (no tenant_id; RLS restricts a tenant session to its own row).
CREATE TABLE tenant (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  slug        citext NOT NULL UNIQUE,
  status      text NOT NULL DEFAULT 'TRIALING' CHECK (status IN ('TRIALING','ACTIVE','PAST_DUE','SUSPENDED','CANCELLED','ARCHIVED')),
  referred_by text,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE legal_entity (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  ntn        text,
  strn       text,
  address    text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE brand (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE property (
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  legal_entity_id uuid NOT NULL,
  brand_id        uuid,
  code            text NOT NULL,
  name            text NOT NULL,
  timezone        text NOT NULL DEFAULT 'Asia/Karachi',
  currency        char(3) NOT NULL DEFAULT 'PKR',
  business_date   date NOT NULL,                         -- hotel business date; advanced only by Night Audit
  status          text NOT NULL DEFAULT 'SETUP' CHECK (status IN ('SETUP','LIVE','SUSPENDED','ARCHIVED')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, brand_id)        REFERENCES brand (tenant_id, id)
);

CREATE TABLE staff_user (
  tenant_id        uuid NOT NULL REFERENCES tenant(id),
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  email            citext NOT NULL,
  full_name        text NOT NULL,
  preferred_locale text NOT NULL DEFAULT 'en' CHECK (preferred_locale IN ('en','ur')),
  status           text NOT NULL DEFAULT 'INVITED' CHECK (status IN ('INVITED','ACTIVE','DISABLED')),
  password_hash    text,
  mfa_enabled      boolean NOT NULL DEFAULT false,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, email)
);

-- Global reference data (allow-listed in the isolation lint).
CREATE TABLE permission (
  key         text PRIMARY KEY CHECK (key ~ '^[a-z_]+\.[a-z_]+$'),
  description text NOT NULL
);

CREATE TABLE role (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  key        text NOT NULL,
  name       text NOT NULL,
  is_system  boolean NOT NULL DEFAULT false,   -- system roles are seeded per tenant from templates
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, key)
);

CREATE TABLE role_permission (
  tenant_id      uuid NOT NULL,
  role_id        uuid NOT NULL,
  permission_key text NOT NULL REFERENCES permission(key),
  PRIMARY KEY (tenant_id, role_id, permission_key),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE role_assignment (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  role_id    uuid NOT NULL,
  scope_type text NOT NULL CHECK (scope_type IN ('TENANT','LEGAL_ENTITY','PROPERTY','DEPARTMENT')),
  scope_id   uuid,
  limits     jsonb NOT NULL DEFAULT '{}'::jsonb,   -- e.g. {"max_discount_pct":10,"max_refund_minor":500000}
  valid_from timestamptz NOT NULL DEFAULT now(),
  valid_to   timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK ((scope_type = 'TENANT') = (scope_id IS NULL)),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id),
  FOREIGN KEY (tenant_id, role_id) REFERENCES role (tenant_id, id)
);
CREATE INDEX role_assignment_user_idx ON role_assignment (tenant_id, user_id);

-- Append-only audit trail (partition by month in a later migration when volume warrants).
CREATE TABLE audit_log (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  actor_type    text NOT NULL CHECK (actor_type IN ('USER','API_CLIENT','SYSTEM','PLATFORM_USER')),
  actor_id      uuid,
  on_behalf_of  uuid,
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  property_id   uuid,
  before        jsonb,
  after         jsonb,
  reason_code   text,
  note          text,
  request_id    text,
  ip            inet,
  user_agent    text,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX audit_log_time_idx ON audit_log (tenant_id, occurred_at DESC);
CREATE INDEX audit_log_resource_idx ON audit_log (tenant_id, resource_type, resource_id);
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- Transactional outbox + idempotent consumers + API idempotency.
CREATE TABLE outbox_event (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  aggregate_type text NOT NULL,
  aggregate_id   text NOT NULL,
  event_type     text NOT NULL,
  event_version  integer NOT NULL DEFAULT 1,
  property_id    uuid,
  business_date  date,
  payload        jsonb NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  published_at   timestamptz,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX outbox_unpublished_idx ON outbox_event (created_at) WHERE published_at IS NULL;

CREATE TABLE inbox_receipt (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  consumer    text NOT NULL,
  event_id    uuid NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, consumer, event_id)
);

CREATE TABLE idempotency_key (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  key          text NOT NULL,
  request_hash text NOT NULL,
  status_code  integer,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL DEFAULT now() + interval '72 hours',
  PRIMARY KEY (tenant_id, key)
);

-- Row-level security on every tenant-owned table.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['legal_entity','brand','property','staff_user','role','role_permission','role_assignment',
                           'audit_log','outbox_event','inbox_receipt','idempotency_key'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
  END LOOP;
END $$;
ALTER TABLE tenant ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_self ON tenant FOR SELECT USING (id = current_tenant_id());

-- Privileges: runtime role is least-privilege; provisioning role is separate and used only by platform jobs.
GRANT USAGE ON SCHEMA public TO hos_app, hos_admin;
GRANT SELECT ON tenant, permission TO hos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON legal_entity, brand, property, staff_user, role, role_permission,
      role_assignment, inbox_receipt, idempotency_key TO hos_app;
GRANT SELECT, INSERT ON audit_log TO hos_app;
GRANT SELECT, INSERT ON outbox_event TO hos_app;
GRANT UPDATE (published_at) ON outbox_event TO hos_app;
GRANT ALL ON ALL TABLES IN SCHEMA public TO hos_admin;
