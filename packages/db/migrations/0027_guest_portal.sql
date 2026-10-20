-- 0027 The guest's own booking page: a private link in the WhatsApp message (no sign-in), the hotel's terms to show on it, and the requests a guest can send from it
-- (airport pick-up and drop, a ground-floor room, wheelchair access, other services). Staff see the requests and answer them.

ALTER TABLE reservation ADD COLUMN guest_token text UNIQUE CHECK (guest_token IS NULL OR guest_token ~ '^[0-9a-f]{32}-[0-9a-f]{32}$');   -- tenant id, then 128 random bits
ALTER TABLE property ADD COLUMN terms_text text CHECK (terms_text IS NULL OR length(terms_text) <= 8000);

CREATE TABLE guest_request (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  reservation_id uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('AIRPORT_PICKUP','AIRPORT_DROP','GROUND_FLOOR','WHEELCHAIR','EARLY_CHECKIN','LATE_CHECKOUT','EXTRA_BED','OTHER')),
  needed_on      date,
  needed_time    text CHECK (needed_time IS NULL OR needed_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  flight_no      text CHECK (flight_no IS NULL OR length(btrim(flight_no)) BETWEEN 2 AND 20),
  passengers     int CHECK (passengers IS NULL OR passengers BETWEEN 1 AND 20),
  note           text CHECK (note IS NULL OR length(note) <= 500),
  status         text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','ACKNOWLEDGED','DONE','DECLINED')),
  staff_note     text CHECK (staff_note IS NULL OR length(staff_note) <= 300),
  handled_by     uuid,
  handled_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservation (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK ((status = 'NEW') = (handled_at IS NULL))
);
CREATE INDEX guest_request_open_idx ON guest_request (tenant_id, property_id, created_at DESC) WHERE status IN ('NEW','ACKNOWLEDGED');
CREATE INDEX guest_request_res_idx ON guest_request (tenant_id, reservation_id);

ALTER TABLE guest_request ENABLE ROW LEVEL SECURITY;
ALTER TABLE guest_request FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guest_request USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON guest_request TO hos_admin;
GRANT SELECT, INSERT, UPDATE ON guest_request TO hos_app;
