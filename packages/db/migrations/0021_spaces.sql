-- 0021 Bookable spaces (the Boulevard conference room): hourly / half-day / full-day hire, a calendar that cannot be double-booked, and a charge that
-- lands on a guest's bill or on a company's account when the hire is completed.

INSERT INTO permission (key, description) VALUES
 ('space.view',   'See bookable spaces (conference room) and their calendar'),
 ('space.book',   'Book, cancel and complete space hires'),
 ('space.manage', 'Set up spaces and their prices')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE space (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  name             text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  name_ur          text,
  capacity         integer CHECK (capacity IS NULL OR capacity BETWEEN 1 AND 2000),
  buffer_minutes   integer NOT NULL DEFAULT 30 CHECK (buffer_minutes BETWEEN 0 AND 240),    -- set-up / changeover time kept free after each hire
  hourly_minor     bigint CHECK (hourly_minor IS NULL OR hourly_minor >= 0),                 -- NULL = not sold that way
  half_day_minor   bigint CHECK (half_day_minor IS NULL OR half_day_minor >= 0),             -- up to 4 hours
  full_day_minor   bigint CHECK (full_day_minor IS NULL OR full_day_minor >= 0),             -- up to 12 hours
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE UNIQUE INDEX space_name_uq ON space (tenant_id, property_id, lower(btrim(name))) WHERE active;

CREATE TABLE space_booking (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  space_id        uuid NOT NULL,
  number          text NOT NULL,
  event_name      text NOT NULL CHECK (length(btrim(event_name)) BETWEEN 2 AND 160),
  host_name       text NOT NULL CHECK (length(btrim(host_name)) BETWEEN 2 AND 160),
  host_phone      text,
  attendees       integer CHECK (attendees IS NULL OR attendees BETWEEN 1 AND 2000),
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  blocked_until   timestamptz NOT NULL,                   -- ends_at plus the changeover buffer as it was when booked
  pricing         text NOT NULL CHECK (pricing IN ('HOURLY','HALF_DAY','FULL_DAY')),
  hours           integer NOT NULL CHECK (hours BETWEEN 1 AND 12),   -- hours charged (HOURLY) or length of the hire rounded up
  amount_minor    bigint NOT NULL CHECK (amount_minor >= 0),          -- before tax
  currency        char(3) NOT NULL,
  bill_to         text NOT NULL CHECK (bill_to IN ('STAY','SEPARATE')),      -- STAY: a charge on a staying guest's bill · SEPARATE: the hire has a bill of its own (someone not staying with us)
  reservation_id  uuid,
  company_id      uuid,
  note            text,
  status          text NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED','COMPLETED','CANCELLED')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz,
  completed_by    uuid,
  folio_id        uuid,                                   -- SEPARATE: the hire's own bill, opened when it is booked (deposits and payments go on it) · STAY: the stay's bill, filled in when the hire is completed
  posting_id      uuid,
  cancel_reason   text,
  cancelled_by    uuid,
  version         integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, number),
  FOREIGN KEY (tenant_id, property_id, space_id) REFERENCES space (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, posting_id) REFERENCES folio_posting (tenant_id, id),
  CHECK (ends_at > starts_at AND blocked_until >= ends_at),
  CHECK ((bill_to = 'STAY' AND reservation_id IS NOT NULL AND company_id IS NULL) OR (bill_to = 'SEPARATE' AND reservation_id IS NULL AND folio_id IS NOT NULL)),
  CHECK ((status = 'COMPLETED') = (completed_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL)),
  -- two hires of one space can never overlap (the buffer counts as part of a hire)
  EXCLUDE USING gist (tenant_id WITH =, space_id WITH =, tstzrange(starts_at, blocked_until) WITH &&) WHERE (status <> 'CANCELLED')
);
CREATE INDEX space_booking_day_idx ON space_booking (tenant_id, property_id, starts_at);
CREATE INDEX space_booking_company_idx ON space_booking (tenant_id, company_id) WHERE company_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['space','space_booking'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON space, space_booking TO hos_app;
