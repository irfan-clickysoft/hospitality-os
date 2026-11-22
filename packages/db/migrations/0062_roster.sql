-- Staff roster: who works which shift in which department, and how many staff each department needs for the rooms in use.
CREATE TABLE roster_shift (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  user_id      uuid NOT NULL,
  shift_date   date NOT NULL,
  department   text NOT NULL CHECK (department IN ('FRONT_DESK','HOUSEKEEPING','MAINTENANCE','FNB','SECURITY','MANAGEMENT')),
  start_time   time NOT NULL,
  end_time     time NOT NULL,
  note         text CHECK (note IS NULL OR length(note) <= 200),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, user_id, shift_date, start_time),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id),
  CHECK (start_time <> end_time)
);
CREATE INDEX roster_shift_date_idx ON roster_shift (tenant_id, property_id, shift_date);
ALTER TABLE roster_shift ENABLE ROW LEVEL SECURITY; ALTER TABLE roster_shift FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON roster_shift USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON roster_shift TO hos_admin; GRANT SELECT, INSERT, DELETE ON roster_shift TO hos_app;

CREATE TABLE staffing_rule (
  tenant_id       uuid NOT NULL,
  property_id     uuid NOT NULL,
  department      text NOT NULL CHECK (department IN ('FRONT_DESK','HOUSEKEEPING','MAINTENANCE','FNB','SECURITY','MANAGEMENT')),
  rooms_per_staff integer NOT NULL CHECK (rooms_per_staff BETWEEN 1 AND 1000),   -- one person for this many occupied rooms
  min_staff       integer NOT NULL DEFAULT 1 CHECK (min_staff BETWEEN 0 AND 100),
  updated_by      uuid,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, department)
);
ALTER TABLE staffing_rule ENABLE ROW LEVEL SECURITY; ALTER TABLE staffing_rule FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON staffing_rule USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON staffing_rule TO hos_admin; GRANT SELECT, INSERT, UPDATE ON staffing_rule TO hos_app;
