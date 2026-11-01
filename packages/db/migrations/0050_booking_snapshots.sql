-- 0050 Daily snapshots of the books: for each stay date, how many room nights (and how much room revenue) were on the books when a business day closed. Booking pace, pickup and the forecast are built from these.
CREATE TABLE booking_snapshot (
  tenant_id       uuid NOT NULL,
  property_id     uuid NOT NULL,
  snapshot_date   date NOT NULL,                       -- the business date that had just closed
  stay_date       date NOT NULL,
  room_type_id    uuid NOT NULL,
  channel         text NOT NULL,
  rooms           integer NOT NULL CHECK (rooms >= 0),            -- confirmed and in-house room nights
  revenue_minor   bigint NOT NULL CHECK (revenue_minor >= 0),     -- their room revenue, excluding tax
  tentative       integer NOT NULL DEFAULT 0 CHECK (tentative >= 0),
  tentative_minor bigint NOT NULL DEFAULT 0 CHECK (tentative_minor >= 0),
  PRIMARY KEY (tenant_id, property_id, snapshot_date, stay_date, room_type_id, channel)
);
CREATE INDEX booking_snapshot_stay_idx ON booking_snapshot (tenant_id, property_id, stay_date, snapshot_date);
CREATE TABLE booking_snapshot_run (
  tenant_id     uuid NOT NULL,
  property_id   uuid NOT NULL,
  snapshot_date date NOT NULL,
  source        text NOT NULL CHECK (source IN ('NIGHT_AUDIT','MANUAL')),
  taken_at      timestamptz NOT NULL DEFAULT now(),
  taken_by      uuid,
  horizon_days  integer NOT NULL,
  rows          integer NOT NULL,
  PRIMARY KEY (tenant_id, property_id, snapshot_date)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['booking_snapshot','booking_snapshot_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
