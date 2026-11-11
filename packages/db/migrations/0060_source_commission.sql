-- Commission each booking source takes (online travel agents, travel agents), as a percentage of room revenue, so reports can show net revenue.
CREATE TABLE source_commission (
  tenant_id    uuid NOT NULL,
  property_id  uuid NOT NULL,
  source       text NOT NULL CHECK (source IN ('WALK_IN','PHONE','WHATSAPP','WEBSITE','OTA_BOOKING_COM','OTA_OTHER','CORPORATE','TRAVEL_AGENT','CRS','OTHER')),
  pct          numeric(5,2) NOT NULL CHECK (pct >= 0 AND pct <= 100),
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, source)
);
ALTER TABLE source_commission ENABLE ROW LEVEL SECURITY; ALTER TABLE source_commission FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON source_commission USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON source_commission TO hos_admin; GRANT SELECT, INSERT, UPDATE ON source_commission TO hos_app;
