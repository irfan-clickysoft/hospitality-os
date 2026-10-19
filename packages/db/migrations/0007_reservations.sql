-- 0007 Guests (minimal profile), reservations (header + room lines + per-night price snapshot), immutable history, confirmation numbers.

ALTER TABLE property
  ADD COLUMN check_in_time  time NOT NULL DEFAULT '14:00',
  ADD COLUMN check_out_time time NOT NULL DEFAULT '12:00';

CREATE TABLE guest (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  full_name    text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  phone        text,
  phone_norm   text,                                        -- digits only, Pakistani numbers normalised to 92XXXXXXXXXX
  email        citext,
  nationality  char(2),                                     -- ISO 3166-1 alpha-2
  residency    text NOT NULL DEFAULT 'RESIDENT' CHECK (residency IN ('RESIDENT','NON_RESIDENT')),
  vip          boolean NOT NULL DEFAULT false,
  do_not_rent  boolean NOT NULL DEFAULT false,
  notes        text,
  version      integer NOT NULL DEFAULT 1,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX guest_phone_idx ON guest (tenant_id, phone_norm) WHERE phone_norm IS NOT NULL;
CREATE INDEX guest_email_idx ON guest (tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX guest_name_trgm ON guest USING gin (full_name gin_trgm_ops);

-- Per-property named counters (confirmation numbers). Incremented atomically with INSERT ... ON CONFLICT DO UPDATE.
CREATE TABLE property_counter (
  tenant_id   uuid NOT NULL,
  property_id uuid NOT NULL,
  name        text NOT NULL,
  value       bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, property_id, name),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);

CREATE TABLE reservation (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  confirmation_no      text NOT NULL,
  guest_id             uuid NOT NULL,
  status               text NOT NULL CHECK (status IN ('OPTION','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW')),   -- derived from its room lines
  source               text NOT NULL CHECK (source IN ('WALK_IN','PHONE','WHATSAPP','WEBSITE','OTA_BOOKING_COM','OTA_OTHER','CORPORATE','TRAVEL_AGENT','CRS','OTHER')),
  channel              text NOT NULL CHECK (channel IN ('DIRECT','PHONE','WALKIN','OTA','CORPORATE','AGENT')),
  market_segment       text,
  external_ref         text,                                  -- OTA reservation id / PO number
  company_id           uuid,                                  -- FK added with the companies module
  residency            text NOT NULL CHECK (residency IN ('RESIDENT','NON_RESIDENT')),
  currency             char(3) NOT NULL,
  option_expires_at    timestamptz,
  guarantee_type       text NOT NULL DEFAULT 'NONE' CHECK (guarantee_type IN ('NONE','DEPOSIT','CARD','COMPANY','OTA_PREPAID')),
  at_risk              boolean NOT NULL DEFAULT false,        -- unguaranteed (typically OTA) booking that may not show
  guarantee_deadline   timestamptz,
  deposit_required_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_required_minor >= 0),
  deposit_paid_minor   bigint NOT NULL DEFAULT 0 CHECK (deposit_paid_minor >= 0),
  reconfirmed_at       timestamptz,
  notes_internal       text,
  notes_guest          text,
  special_requests     text,
  penalty_minor        bigint NOT NULL DEFAULT 0 CHECK (penalty_minor >= 0),    -- cancellation / no-show fee computed from the policy snapshot
  penalty_reason       text,
  penalty_waived       boolean NOT NULL DEFAULT false,
  cancelled_at         timestamptz,
  cancel_reason        text,
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (tenant_id, property_id, confirmation_no),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guest (tenant_id, id),
  CHECK ((status = 'OPTION') = (option_expires_at IS NOT NULL) OR status <> 'OPTION')
);
CREATE INDEX reservation_guest_idx ON reservation (tenant_id, guest_id);
CREATE INDEX reservation_status_idx ON reservation (tenant_id, property_id, status);
CREATE INDEX reservation_option_exp_idx ON reservation (option_expires_at) WHERE status = 'OPTION';
CREATE INDEX reservation_ext_idx ON reservation (tenant_id, property_id, external_ref) WHERE external_ref IS NOT NULL;

CREATE TABLE reservation_room (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  reservation_id   uuid NOT NULL,
  line_no          smallint NOT NULL,
  room_type_id     uuid NOT NULL,
  rate_plan_id     uuid NOT NULL,
  arrival          date NOT NULL,
  departure        date NOT NULL,
  adults           smallint NOT NULL CHECK (adults >= 1),
  children         smallint NOT NULL DEFAULT 0 CHECK (children >= 0),
  extra_beds       smallint NOT NULL DEFAULT 0 CHECK (extra_beds >= 0),
  status           text NOT NULL CHECK (status IN ('OPTION','CONFIRMED','CHECKED_IN','CHECKED_OUT','CANCELLED','NO_SHOW')),
  subtotal_minor   bigint NOT NULL CHECK (subtotal_minor >= 0),            -- before discount, excluding tax
  discount_pct     numeric(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  discount_minor   bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor      bigint NOT NULL CHECK (total_minor >= 0),                -- subtotal − discount, excluding tax
  deposit_due_minor bigint NOT NULL DEFAULT 0 CHECK (deposit_due_minor >= 0),
  policy           jsonb NOT NULL,                                          -- snapshot of cancellation / no-show / deposit rules at booking time
  version          integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reservation_id, line_no),
  CHECK (departure > arrival),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, rate_plan_id) REFERENCES rate_plan (tenant_id, property_id, id)
);
CREATE INDEX reservation_room_arrival_idx ON reservation_room (tenant_id, property_id, arrival) WHERE status IN ('OPTION','CONFIRMED');
CREATE INDEX reservation_room_departure_idx ON reservation_room (tenant_id, property_id, departure) WHERE status = 'CHECKED_IN';
CREATE INDEX reservation_room_range_idx ON reservation_room USING gist (tenant_id, property_id, daterange(arrival, departure)) WHERE status IN ('OPTION','CONFIRMED','CHECKED_IN');
CREATE INDEX reservation_room_res_idx ON reservation_room (tenant_id, reservation_id);

-- Price snapshot per night: later rate edits never change an existing booking.
CREATE TABLE stay_night (
  tenant_id          uuid NOT NULL,
  property_id        uuid NOT NULL,
  reservation_room_id uuid NOT NULL,
  business_date      date NOT NULL,
  source             text NOT NULL,
  room_minor         bigint NOT NULL CHECK (room_minor >= 0),
  extras_minor       bigint NOT NULL CHECK (extras_minor >= 0),
  discount_minor     bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  total_minor        bigint NOT NULL CHECK (total_minor >= 0),               -- room + extras − discount (excluding tax)
  PRIMARY KEY (tenant_id, reservation_room_id, business_date),
  FOREIGN KEY (tenant_id, reservation_room_id) REFERENCES reservation_room (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX stay_night_date_idx ON stay_night (tenant_id, property_id, business_date);

-- Immutable state history.
CREATE TABLE reservation_history (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL,
  reservation_id      uuid NOT NULL,
  reservation_room_id uuid,
  action              text NOT NULL,
  from_status         text,
  to_status           text,
  actor_id            uuid,
  reason              text,
  details             jsonb,
  occurred_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id)
);
CREATE INDEX reservation_history_idx ON reservation_history (tenant_id, reservation_id, occurred_at);
CREATE TRIGGER reservation_history_append_only BEFORE UPDATE OR DELETE ON reservation_history FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER reservation_history_no_truncate BEFORE TRUNCATE ON reservation_history FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- Room assignment history: ended assignments are kept.
ALTER TABLE room_assignment ADD COLUMN ended_at timestamptz, ADD COLUMN end_reason text;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['guest','property_counter','reservation','reservation_room','stay_night','reservation_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON guest, property_counter, reservation, reservation_room TO hos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON stay_night TO hos_app;     -- modifications rewrite the night snapshot
GRANT SELECT, INSERT ON reservation_history TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('reservation.override_rate', 'Keep or set a price different from the quoted rate (complimentary upgrade, manual rate)'),
 ('reservation.waive_fee',     'Waive a cancellation or no-show fee'),
 ('guest.view',                'View guest profiles'),
 ('guest.manage',              'Create and edit guest profiles')
ON CONFLICT (key) DO NOTHING;
