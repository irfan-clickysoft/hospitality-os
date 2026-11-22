-- The room-night forecast as it stood when each business day closed, so it can be compared with what was really sold.
CREATE TABLE forecast_saved (
  tenant_id        uuid NOT NULL,
  property_id      uuid NOT NULL,
  made_on          date NOT NULL,                 -- the business date that had just closed
  stay_date        date NOT NULL,
  lead             integer NOT NULL CHECK (lead >= 1),
  on_books         integer NOT NULL CHECK (on_books >= 0),
  expected_pickup  numeric(7,2) NOT NULL,
  forecast_nights  integer NOT NULL CHECK (forecast_nights >= 0),
  sellable         integer NOT NULL CHECK (sellable >= 0),
  samples          integer NOT NULL,
  PRIMARY KEY (tenant_id, property_id, made_on, stay_date)
);
CREATE INDEX forecast_saved_stay_idx ON forecast_saved (tenant_id, property_id, stay_date);
ALTER TABLE forecast_saved ENABLE ROW LEVEL SECURITY; ALTER TABLE forecast_saved FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON forecast_saved USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON forecast_saved TO hos_admin; GRANT SELECT, INSERT, DELETE ON forecast_saved TO hos_app;
