-- 0052 Early check-in and late checkout fees: the property's fee tiers, and an immutable record of each decision (charged or waived, by whom, why) for the report.
ALTER TABLE property ADD COLUMN timing_fee_rule jsonb;
CREATE TABLE timing_fee_event (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  reservation_id       uuid NOT NULL,
  reservation_room_id  uuid NOT NULL,
  kind                 text NOT NULL CHECK (kind IN ('EARLY_CHECKIN','LATE_CHECKOUT')),
  business_date        date NOT NULL,
  standard_time        text NOT NULL,
  actual_time          text NOT NULL,                                        -- the hotel's local time when it was decided
  minutes_off          integer NOT NULL CHECK (minutes_off > 0),
  requested_time       text,                                                 -- what the guest asked for, if they asked
  night_minor          bigint NOT NULL CHECK (night_minor >= 0),             -- the night the fee is a share of
  suggested_percent    numeric NOT NULL DEFAULT 0,
  suggested_minor      bigint NOT NULL DEFAULT 0 CHECK (suggested_minor >= 0),
  action               text NOT NULL CHECK (action IN ('CHARGE','WAIVE')),
  charged_minor        bigint NOT NULL DEFAULT 0 CHECK (charged_minor >= 0),
  waived_minor         bigint NOT NULL DEFAULT 0 CHECK (waived_minor >= 0),
  reason               text CHECK (reason IS NULL OR length(reason) <= 300),
  posting_id           uuid,
  decided_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reservation_room_id, kind)
);
CREATE INDEX timing_fee_event_prop_idx ON timing_fee_event (tenant_id, property_id, business_date);
ALTER TABLE timing_fee_event ENABLE ROW LEVEL SECURITY; ALTER TABLE timing_fee_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON timing_fee_event USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON timing_fee_event TO hos_admin;
GRANT SELECT, INSERT ON timing_fee_event TO hos_app;                         -- decisions are never edited or removed; a wrong charge is reversed on the bill
