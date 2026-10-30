-- 0049 Damage cases and complaint/incident cases: two registers with an immutable event history, private evidence pictures, and (for damage) a charge that lands on the guest's bill.
INSERT INTO permission (key, description) VALUES
 ('damage.report',   'Log suspected damage and add evidence'),
 ('damage.view',     'See damage cases'),
 ('damage.manage',   'Verify damage, set costs, tell the guest, and record their response'),
 ('damage.charge',   'Approve, charge, or waive a damage charge on the guest bill'),
 ('case.report',     'Log a complaint or incident'),
 ('case.view',       'See complaints and ordinary incidents'),
 ('case.manage',     'Own, update, resolve and close complaints and incidents'),
 ('case.restricted', 'See and manage restricted cases: safety, security, medical and anything marked confidential')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE damage_case (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL,
  ref                text NOT NULL,
  reservation_id     uuid,
  reservation_room_id uuid,
  room_id            uuid,
  guest_id           uuid,
  discovered_at      timestamptz NOT NULL DEFAULT now(),
  area               text NOT NULL CHECK (length(area) BETWEEN 2 AND 120),
  category           text NOT NULL CHECK (category IN ('FURNITURE','FIXTURE','ELECTRONICS','LINEN','WALLS_FLOORS','APPLIANCE','KEYS','OTHER')),
  severity           text NOT NULL CHECK (severity IN ('MINOR','MODERATE','MAJOR')),
  description        text NOT NULL CHECK (length(description) BETWEEN 3 AND 2000),
  status             text NOT NULL DEFAULT 'SUSPECTED' CHECK (status IN ('SUSPECTED','VERIFIED','CHARGE_APPROVED','CHARGED','WAIVED','DISPUTED','DISMISSED','RESOLVED')),
  estimated_minor    bigint CHECK (estimated_minor IS NULL OR estimated_minor >= 0),
  actual_minor       bigint CHECK (actual_minor IS NULL OR actual_minor >= 0),
  charge_minor       bigint CHECK (charge_minor IS NULL OR charge_minor >= 0),
  waived_minor       bigint NOT NULL DEFAULT 0 CHECK (waived_minor >= 0),
  waive_reason       text CHECK (waive_reason IS NULL OR length(waive_reason) <= 300),
  guest_notified_at  timestamptz,
  guest_notified_by  uuid,
  guest_response     text CHECK (guest_response IN ('ACKNOWLEDGED','DISPUTED')),
  guest_response_note text CHECK (guest_response_note IS NULL OR length(guest_response_note) <= 500),
  guest_response_at  timestamptz,
  approved_by        uuid,
  approved_at        timestamptz,
  charged_by         uuid,
  charged_at         timestamptz,
  folio_id           uuid,
  posting_id         uuid,
  internal_note      text CHECK (internal_note IS NULL OR length(internal_note) <= 2000),
  resolution_note    text CHECK (resolution_note IS NULL OR length(resolution_note) <= 500),
  reported_by        uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, ref)
);
CREATE INDEX damage_case_prop_idx ON damage_case (tenant_id, property_id, status, discovered_at DESC);
CREATE INDEX damage_case_res_idx ON damage_case (tenant_id, reservation_id);
CREATE TABLE damage_event (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), damage_id uuid NOT NULL, action text NOT NULL, note text, details jsonb, actor_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX damage_event_idx ON damage_event (tenant_id, damage_id, at);
CREATE TABLE damage_media (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), damage_id uuid NOT NULL, file_name text NOT NULL, uploaded_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX damage_media_idx ON damage_media (tenant_id, damage_id);

CREATE TABLE case_record (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL,
  ref                text NOT NULL,
  type               text NOT NULL CHECK (type IN ('GUEST_COMPLAINT','SERVICE_FAILURE','SAFETY','SECURITY','MEDICAL','INTERNAL')),
  category           text CHECK (category IS NULL OR length(category) <= 60),
  severity           text NOT NULL CHECK (severity IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  confidentiality    text NOT NULL DEFAULT 'NORMAL' CHECK (confidentiality IN ('NORMAL','RESTRICTED')),
  reservation_id     uuid,
  room_id            uuid,
  guest_id           uuid,
  occurred_at        timestamptz NOT NULL DEFAULT now(),
  reported_at        timestamptz NOT NULL DEFAULT now(),
  channel            text NOT NULL DEFAULT 'IN_PERSON' CHECK (channel IN ('IN_PERSON','PHONE','WHATSAPP','EMAIL','ONLINE_REVIEW','STAFF')),
  reporter_name      text CHECK (reporter_name IS NULL OR length(reporter_name) <= 160),
  reported_by        uuid NOT NULL,
  owner_id           uuid,
  sla_due_at         timestamptz NOT NULL,
  description        text NOT NULL CHECK (length(description) BETWEEN 3 AND 3000),
  immediate_action   text CHECK (immediate_action IS NULL OR length(immediate_action) <= 1000),
  root_cause         text CHECK (root_cause IS NULL OR length(root_cause) <= 1000),
  corrective_action  text CHECK (corrective_action IS NULL OR length(corrective_action) <= 1000),
  preventive_action  text CHECK (preventive_action IS NULL OR length(preventive_action) <= 1000),
  compensation_note  text CHECK (compensation_note IS NULL OR length(compensation_note) <= 300),
  compensation_minor bigint CHECK (compensation_minor IS NULL OR compensation_minor >= 0),
  status             text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','IN_PROGRESS','RESOLVED','CLOSED')),
  resolved_at        timestamptz,
  resolved_by        uuid,
  resolution_note    text CHECK (resolution_note IS NULL OR length(resolution_note) <= 1000),
  followup_at        timestamptz,
  followup_note      text CHECK (followup_note IS NULL OR length(followup_note) <= 500),
  created_at         timestamptz NOT NULL DEFAULT now(),
  version            integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, ref)
);
CREATE INDEX case_record_prop_idx ON case_record (tenant_id, property_id, status, occurred_at DESC);
CREATE TABLE case_event (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), case_id uuid NOT NULL, action text NOT NULL, note text, details jsonb, actor_id uuid NOT NULL, at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX case_event_idx ON case_event (tenant_id, case_id, at);
CREATE TABLE case_media (
  tenant_id uuid NOT NULL, id uuid NOT NULL DEFAULT gen_random_uuid(), case_id uuid NOT NULL, file_name text NOT NULL, uploaded_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX case_media_idx ON case_media (tenant_id, case_id);

-- tenant isolation, as for every tenant table
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['damage_case','damage_event','damage_media','case_record','case_event','case_media'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
-- the histories only ever grow
REVOKE UPDATE, DELETE ON damage_event, case_event FROM hos_app;
