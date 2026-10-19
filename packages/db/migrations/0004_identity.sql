-- 0004 Identity: sessions, MFA, recovery codes, invitation/reset tokens, lockout, staffing permissions.

ALTER TABLE staff_user
  ADD COLUMN failed_login_count    integer     NOT NULL DEFAULT 0,
  ADD COLUMN locked_until          timestamptz,
  ADD COLUMN last_login_at         timestamptz,
  ADD COLUMN password_changed_at   timestamptz;

CREATE TABLE user_session (
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL,
  token_hash           bytea NOT NULL,                      -- sha256 of the opaque token; the token itself is never stored
  csrf_token           text NOT NULL,
  state                text NOT NULL CHECK (state IN ('PENDING_MFA','ACTIVE')),
  created_at           timestamptz NOT NULL DEFAULT now(),
  last_seen_at         timestamptz NOT NULL DEFAULT now(),
  idle_expires_at      timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  mfa_verified_at      timestamptz,
  revoked_at           timestamptz,
  mfa_failed_count     integer NOT NULL DEFAULT 0,
  ip                   inet,
  user_agent           text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id)
);
CREATE INDEX user_session_user_idx ON user_session (tenant_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE user_mfa_totp (
  tenant_id    uuid NOT NULL,
  user_id      uuid NOT NULL,
  secret_enc   text NOT NULL,                               -- AES-256-GCM envelope (see SecretBox); never plaintext
  confirmed_at timestamptz,
  last_used_step bigint,                                    -- RFC 6238 time-step of the last accepted code (replay protection)
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id)
);

CREATE TABLE user_recovery_code (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  code_hash  bytea NOT NULL,
  used_at    timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id)
);

CREATE TABLE user_token (
  tenant_id  uuid NOT NULL,
  id         uuid NOT NULL DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL,
  purpose    text NOT NULL CHECK (purpose IN ('INVITE','PASSWORD_RESET')),
  token_hash bytea NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user_session','user_mfa_totp','user_recovery_code','user_token'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
GRANT ALL ON user_session, user_mfa_totp, user_recovery_code, user_token TO hos_admin;

-- Login happens before the tenant is known. Allow a transaction to look up ONE tenant row by slug (id + status only matter).
CREATE POLICY tenant_slug_lookup ON tenant FOR SELECT
  USING (slug = NULLIF(current_setting('app.lookup_slug', true), '')::citext);

-- Staffing-driven permissions (kitchen, housekeeping, gate security).
INSERT INTO permission (key, description) VALUES
 ('fnb.order',            'Take and view kitchen / restaurant orders'),
 ('fnb.manage',           'Manage menu, kitchen queue and F&B charges'),
 ('housekeeping.view',    'View the housekeeping board and room status'),
 ('housekeeping.update',  'Update the status of assigned rooms (start/finish cleaning, report issues)'),
 ('housekeeping.assign',  'Assign rooms to attendants and inspect rooms'),
 ('arrivals.view_masked', 'View today''s arrivals with guest data masked (gate security)'),
 ('visitor.log',          'Record visitors and vehicles at the gate')
ON CONFLICT (key) DO NOTHING;
