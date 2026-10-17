-- 0006 Rate plans, base/weekend/seasonal/override prices, restrictions. Money = bigint minor units (currency from the property).

ALTER TABLE property ADD COLUMN weekend_days smallint[] NOT NULL DEFAULT '{5,6}'
  CHECK (weekend_days <@ ARRAY[1,2,3,4,5,6,7]::smallint[]);   -- ISO weekdays whose NIGHT is priced as "weekend" (configurable per property)

CREATE TABLE rate_plan (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  code                 text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{2,24}$'),
  name                 text NOT NULL,
  description          text,
  kind                 text NOT NULL DEFAULT 'BASE' CHECK (kind IN ('BASE','DERIVED')),
  parent_rate_plan_id  uuid,
  derive_type          text CHECK (derive_type IN ('PERCENT','FIXED')),
  derive_value         bigint,                         -- PERCENT: basis points (2000 = +20%, -1000 = -10%); FIXED: minor units (+/-)
  derive_round_minor   integer NOT NULL DEFAULT 100 CHECK (derive_round_minor >= 1),   -- round derived prices to a multiple of this (minor units)
  meal_plan            text NOT NULL DEFAULT 'ROOM_ONLY' CHECK (meal_plan IN ('ROOM_ONLY','BREAKFAST','HALF_BOARD','FULL_BOARD')),
  audience             text NOT NULL DEFAULT 'PUBLIC' CHECK (audience IN ('PUBLIC','CORPORATE','AGENT')),
  residency            text NOT NULL DEFAULT 'ANY' CHECK (residency IN ('ANY','RESIDENT','NON_RESIDENT')),   -- dual (local / foreign) pricing
  channels             text[] NOT NULL DEFAULT '{DIRECT,PHONE,WALKIN,OTA,CORPORATE,AGENT}',
  company_ids          uuid[] NOT NULL DEFAULT '{}',   -- CORPORATE/AGENT plans: eligible companies (FK added with the companies module)
  min_los              smallint NOT NULL DEFAULT 1 CHECK (min_los >= 1),
  max_los              smallint CHECK (max_los IS NULL OR max_los >= min_los),
  min_advance_days     smallint NOT NULL DEFAULT 0 CHECK (min_advance_days >= 0),
  max_advance_days     smallint CHECK (max_advance_days IS NULL OR max_advance_days >= min_advance_days),
  extra_bed_minor      bigint NOT NULL DEFAULT 0 CHECK (extra_bed_minor >= 0),            -- per bed per night
  extra_adult_meal_minor bigint NOT NULL DEFAULT 0 CHECK (extra_adult_meal_minor >= 0),   -- per extra adult per night when meal plan is not room-only
  extra_child_meal_minor bigint NOT NULL DEFAULT 0 CHECK (extra_child_meal_minor >= 0),
  cancellation_rule    jsonb,                           -- {freeUntilHoursBefore, feeType: NIGHTS|PERCENT|FIXED, feeValue}
  no_show_rule         jsonb,                           -- {feeType, feeValue}
  deposit_rule         jsonb,                           -- {type: NIGHTS|PERCENT|FIXED, value, dueWithinHours}
  valid_from           date,
  valid_to             date,                            -- inclusive last stay-night date
  status               text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order           integer NOT NULL DEFAULT 0,
  version              integer NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (tenant_id, property_id, code),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, parent_rate_plan_id) REFERENCES rate_plan (tenant_id, property_id, id),
  CHECK ((kind = 'BASE' AND parent_rate_plan_id IS NULL AND derive_type IS NULL AND derive_value IS NULL)
      OR (kind = 'DERIVED' AND parent_rate_plan_id IS NOT NULL AND derive_type IS NOT NULL AND derive_value IS NOT NULL AND parent_rate_plan_id <> id)),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from)
);

CREATE TABLE rate_base (
  tenant_id            uuid NOT NULL,
  property_id          uuid NOT NULL,
  rate_plan_id         uuid NOT NULL,
  room_type_id         uuid NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor >= 0),      -- per night at base occupancy
  weekend_amount_minor bigint CHECK (weekend_amount_minor >= 0),       -- NULL = same as weekday
  extra_adult_minor    bigint NOT NULL DEFAULT 0 CHECK (extra_adult_minor >= 0),   -- per extra adult per night (above base occupancy)
  extra_child_minor    bigint NOT NULL DEFAULT 0 CHECK (extra_child_minor >= 0),
  PRIMARY KEY (tenant_id, rate_plan_id, room_type_id),
  FOREIGN KEY (tenant_id, property_id, rate_plan_id) REFERENCES rate_plan (tenant_id, property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id)
);

CREATE TABLE rate_season (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  rate_plan_id uuid NOT NULL,
  name         text NOT NULL,
  start_date   date NOT NULL,
  end_date     date NOT NULL,                 -- exclusive
  priority     integer NOT NULL DEFAULT 0,    -- higher wins when seasons overlap
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, rate_plan_id, id),
  CHECK (end_date > start_date),
  FOREIGN KEY (tenant_id, property_id, rate_plan_id) REFERENCES rate_plan (tenant_id, property_id, id) ON DELETE CASCADE
);
CREATE TABLE rate_season_value (
  tenant_id            uuid NOT NULL,
  property_id          uuid NOT NULL,
  rate_plan_id         uuid NOT NULL,
  season_id            uuid NOT NULL,
  room_type_id         uuid NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor >= 0),
  weekend_amount_minor bigint CHECK (weekend_amount_minor >= 0),
  PRIMARY KEY (tenant_id, season_id, room_type_id),
  FOREIGN KEY (tenant_id, rate_plan_id, season_id) REFERENCES rate_season (tenant_id, rate_plan_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id)
);

-- Explicit price for one night (highest precedence in the plan).
CREATE TABLE rate_override (
  tenant_id     uuid NOT NULL,
  property_id   uuid NOT NULL,
  rate_plan_id  uuid NOT NULL,
  room_type_id  uuid NOT NULL,
  business_date date NOT NULL,
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  PRIMARY KEY (tenant_id, rate_plan_id, room_type_id, business_date),
  FOREIGN KEY (tenant_id, property_id, rate_plan_id) REFERENCES rate_plan (tenant_id, property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id)
);

CREATE TABLE rate_restriction (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  rate_plan_id     uuid NOT NULL,
  room_type_id     uuid,                         -- NULL = every room type
  start_date       date NOT NULL,
  end_date         date NOT NULL,                -- exclusive
  min_los          smallint CHECK (min_los >= 1),
  max_los          smallint CHECK (max_los >= 1),
  closed_to_arrival   boolean NOT NULL DEFAULT false,
  closed_to_departure boolean NOT NULL DEFAULT false,
  stop_sell        boolean NOT NULL DEFAULT false,
  min_advance_days smallint CHECK (min_advance_days >= 0),
  max_advance_days smallint CHECK (max_advance_days >= 0),
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (end_date > start_date),
  FOREIGN KEY (tenant_id, property_id, rate_plan_id) REFERENCES rate_plan (tenant_id, property_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id)
);
CREATE INDEX rate_restriction_lookup ON rate_restriction (tenant_id, rate_plan_id, start_date, end_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rate_plan','rate_base','rate_season','rate_season_value','rate_override','rate_restriction'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
