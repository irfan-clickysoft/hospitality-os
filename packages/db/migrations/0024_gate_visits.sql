-- 0024 Gate log: visitors, vehicles, deliveries and contractors coming in and going out, kept by gate security. Deliberately light on personal data: a name, a phone, the last
-- four characters of an ID if one was shown, never the whole number.

CREATE TABLE gate_visit (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('VISITOR','VEHICLE','DELIVERY','CONTRACTOR')),
  name         text CHECK (name IS NULL OR length(btrim(name)) BETWEEN 2 AND 120),
  phone        text CHECK (phone IS NULL OR length(phone) <= 30),
  id_last4     text CHECK (id_last4 IS NULL OR id_last4 ~ '^[0-9A-Za-z]{4}$'),
  plate        text CHECK (plate IS NULL OR length(btrim(plate)) BETWEEN 2 AND 20),
  visiting     text CHECK (visiting IS NULL OR length(visiting) <= 120),          -- a room, a guest, or a department
  purpose      text CHECK (purpose IS NULL OR length(purpose) <= 200),
  note         text CHECK (note IS NULL OR length(note) <= 300),
  in_at        timestamptz NOT NULL DEFAULT now(),
  out_at       timestamptz,
  logged_by    uuid NOT NULL,
  out_by       uuid,
  business_date date NOT NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK (name IS NOT NULL OR plate IS NOT NULL),                                   -- somebody or something must be identified
  CHECK (out_at IS NULL OR out_at >= in_at),
  CHECK ((out_at IS NULL) = (out_by IS NULL))
);
CREATE INDEX gate_visit_open_idx ON gate_visit (tenant_id, property_id, in_at DESC) WHERE out_at IS NULL;
CREATE INDEX gate_visit_day_idx ON gate_visit (tenant_id, property_id, business_date);

ALTER TABLE gate_visit ENABLE ROW LEVEL SECURITY;
ALTER TABLE gate_visit FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gate_visit USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON gate_visit TO hos_admin;
GRANT SELECT, INSERT, UPDATE ON gate_visit TO hos_app;
