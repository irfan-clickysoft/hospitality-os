-- 0010 Housekeeping: tasks, do-not-disturb, room issues reported by staff, lost & found.

ALTER TABLE room DROP CONSTRAINT room_hk_status_check;
ALTER TABLE room ADD CONSTRAINT room_hk_status_check CHECK (hk_status IN ('CLEAN','DIRTY','CLEANING','INSPECTED'));
ALTER TABLE room ADD COLUMN dnd boolean NOT NULL DEFAULT false;                                   -- do-not-disturb is a flag, not a status: a room can be DND and dirty
ALTER TABLE property ADD COLUMN hk_require_inspection boolean NOT NULL DEFAULT false;

CREATE TABLE housekeeping_task (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  room_id          uuid NOT NULL,
  task_type        text NOT NULL CHECK (task_type IN ('CHECKOUT_CLEAN','STAYOVER','ARRIVAL_PREP','DEEP_CLEAN','ON_DEMAND')),
  business_date    date NOT NULL,
  priority         smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),         -- 1 = urgent (VIP / same-day turn), 4 = low
  status           text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','IN_PROGRESS','DONE','SKIPPED','CANCELLED')),
  assigned_to      uuid,
  credit           numeric(4,2) NOT NULL DEFAULT 1,                                          -- workload points
  notes            text,
  source_key       text,                                                                     -- makes automatic generation repeatable
  started_at       timestamptz,
  finished_at      timestamptz,
  inspection       text CHECK (inspection IN ('PENDING','PASSED','FAILED')),
  inspected_by     uuid,
  inspected_at     timestamptz,
  inspection_note  text,
  rework_count     smallint NOT NULL DEFAULT 0,
  skip_reason      text,
  version          integer NOT NULL DEFAULT 1,
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES room (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, assigned_to) REFERENCES staff_user (tenant_id, id)
);
CREATE UNIQUE INDEX housekeeping_task_source ON housekeeping_task (tenant_id, property_id, source_key) WHERE source_key IS NOT NULL;
CREATE INDEX housekeeping_task_open_idx ON housekeeping_task (tenant_id, property_id, business_date) WHERE status IN ('PENDING','IN_PROGRESS','DONE');
CREATE INDEX housekeeping_task_mine_idx ON housekeeping_task (tenant_id, assigned_to) WHERE status IN ('PENDING','IN_PROGRESS');
CREATE INDEX housekeeping_task_room_idx ON housekeeping_task (tenant_id, room_id, created_at DESC);

CREATE TABLE room_issue (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  room_id         uuid,
  area            text,
  category        text NOT NULL CHECK (category IN ('PLUMBING','ELECTRICAL','AC','FURNITURE','APPLIANCE','CLEANLINESS','OTHER')),
  description     text NOT NULL CHECK (length(btrim(description)) BETWEEN 3 AND 500),
  priority        smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  reported_by     uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_by     uuid,
  resolved_at     timestamptz,
  resolution_note text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES room (tenant_id, property_id, id),
  CHECK (room_id IS NOT NULL OR area IS NOT NULL)
);
CREATE INDEX room_issue_open_idx ON room_issue (tenant_id, property_id, status, created_at DESC);

CREATE TABLE lost_found (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  room_id      uuid,
  location     text,
  item         text NOT NULL CHECK (length(btrim(item)) BETWEEN 2 AND 200),
  description  text,
  status       text NOT NULL DEFAULT 'FOUND' CHECK (status IN ('FOUND','RETURNED','DISPOSED')),
  found_by     uuid NOT NULL,
  found_at     timestamptz NOT NULL DEFAULT now(),
  closed_by    uuid,
  closed_at    timestamptz,
  closed_note  text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES room (tenant_id, property_id, id)
);
CREATE INDEX lost_found_idx ON lost_found (tenant_id, property_id, status, found_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['housekeeping_task','room_issue','lost_found'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
