-- 0011 Night audit: runs and their steps (resumable), and the immutable daily snapshots reports are read from.

CREATE TABLE night_audit_run (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  business_date  date NOT NULL,                                -- the day being closed
  status         text NOT NULL CHECK (status IN ('RUNNING','FAILED','COMPLETED')),
  mode           text NOT NULL DEFAULT 'MANUAL' CHECK (mode IN ('MANUAL','AUTO')),
  started_by     uuid NOT NULL,
  started_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz,
  overrides      jsonb NOT NULL DEFAULT '[]'::jsonb,           -- blocking exceptions a manager chose to proceed past, with reasons
  resumed_count  integer NOT NULL DEFAULT 0,
  error          text,
  summary        jsonb,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
-- a day can only be audited once, and never by two runs at the same time
CREATE UNIQUE INDEX night_audit_one_active ON night_audit_run (tenant_id, property_id, business_date) WHERE status IN ('RUNNING','COMPLETED');
CREATE INDEX night_audit_run_idx ON night_audit_run (tenant_id, property_id, business_date DESC);

CREATE TABLE night_audit_step (
  tenant_id    uuid NOT NULL,
  run_id       uuid NOT NULL,
  step_key     text NOT NULL,
  seq          smallint NOT NULL,
  status       text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','DONE','FAILED')),
  attempts     integer NOT NULL DEFAULT 0,
  started_at   timestamptz,
  finished_at  timestamptz,
  result       jsonb,
  error        text,
  PRIMARY KEY (tenant_id, run_id, step_key),
  FOREIGN KEY (tenant_id, run_id) REFERENCES night_audit_run (tenant_id, id)
);

-- Snapshots: written once, in the same transaction that rolls the business date. Reports read these, never the live tables, so a past day never changes.
CREATE TABLE daily_property_stats (
  tenant_id             uuid NOT NULL,
  property_id           uuid NOT NULL,
  business_date         date NOT NULL,
  run_id                uuid NOT NULL,
  currency              char(3) NOT NULL,
  rooms_total           integer NOT NULL,
  rooms_out_of_order    integer NOT NULL,
  rooms_available       integer NOT NULL,                      -- total less out-of-order (the documented default)
  rooms_sold            integer NOT NULL,
  occupancy_bp          integer NOT NULL,                      -- basis points: 7500 = 75.00%
  room_revenue_minor    bigint NOT NULL,                       -- room + extras − discounts, net of reversals, excluding tax
  fees_minor            bigint NOT NULL,                       -- cancellation and no-show fees
  other_revenue_minor   bigint NOT NULL,
  adr_minor             bigint NOT NULL,
  revpar_minor          bigint NOT NULL,
  arrivals              integer NOT NULL,
  departures            integer NOT NULL,
  in_house              integer NOT NULL,                      -- at the close of the day
  no_shows              integer NOT NULL,
  cancellations         integer NOT NULL,
  guest_ledger_minor    bigint NOT NULL,                       -- what in-house and unsettled guests owe at close
  advance_deposits_minor bigint NOT NULL,                      -- money held for guests (liability)
  payments              jsonb NOT NULL,                        -- net received by tender, e.g. {"PAY_CASH":"120000"}
  cashier_variance_minor bigint NOT NULL,
  details               jsonb NOT NULL,                        -- the day's lists: in-house, arrivals, departures, no-shows, outstanding folios
  generated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, business_date),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES night_audit_run (tenant_id, id)
);
CREATE TABLE daily_revenue_line (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  business_date  date NOT NULL,
  run_id         uuid NOT NULL,
  txn_code       text NOT NULL,
  room_type_id   uuid,
  source         text,
  posting_count  integer NOT NULL,
  amount_minor   bigint NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE UNIQUE INDEX daily_revenue_line_uq ON daily_revenue_line (tenant_id, property_id, business_date, txn_code, coalesce(room_type_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(source, ''));
CREATE TRIGGER daily_stats_append_only BEFORE UPDATE OR DELETE ON daily_property_stats FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER daily_stats_no_truncate BEFORE TRUNCATE ON daily_property_stats FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER daily_revenue_append_only BEFORE UPDATE OR DELETE ON daily_revenue_line FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER daily_revenue_no_truncate BEFORE TRUNCATE ON daily_revenue_line FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['night_audit_run','night_audit_step','daily_property_stats','daily_revenue_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON night_audit_run, night_audit_step TO hos_app;
GRANT SELECT, INSERT ON daily_property_stats, daily_revenue_line TO hos_app;

-- The posting freeze: every posting takes a SHARE lock on its property row, and the audit's closing step takes an exclusive lock on it.
-- So no posting can slip into a day between the snapshot and the roll — it waits, then sees the new date and is refused if it is for the closed day.
CREATE OR REPLACE FUNCTION folio_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f_status text; p_date date;
BEGIN
  SELECT status INTO f_status FROM folio WHERE tenant_id = NEW.tenant_id AND id = NEW.folio_id FOR UPDATE;
  IF f_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'folio is not open' USING ERRCODE = 'P0001', HINT = 'FOLIO_NOT_OPEN';
  END IF;
  SELECT business_date INTO p_date FROM property WHERE tenant_id = NEW.tenant_id AND id = NEW.property_id FOR SHARE;
  IF NEW.business_date < p_date THEN
    RAISE EXCEPTION 'business date % is closed (current %)', NEW.business_date, p_date USING ERRCODE = 'P0001', HINT = 'BUSINESS_DATE_CLOSED';
  END IF;
  UPDATE folio SET balance_minor = balance_minor + NEW.amount_minor WHERE tenant_id = NEW.tenant_id AND id = NEW.folio_id;
  RETURN NEW;
END $$;

INSERT INTO permission (key, description) VALUES
 ('nightaudit.override', 'Run the night audit past a blocking exception (with a reason)')
ON CONFLICT (key) DO NOTHING;
