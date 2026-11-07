-- Monthly budgets per property: what the owner expects, so reports can show actual against it.
CREATE TABLE budget_month (
  tenant_id            uuid NOT NULL,
  property_id          uuid NOT NULL,
  month                date NOT NULL CHECK (month = date_trunc('month', month)::date),     -- the first day of the month
  room_revenue_minor   bigint NOT NULL DEFAULT 0 CHECK (room_revenue_minor >= 0),
  fnb_revenue_minor    bigint NOT NULL DEFAULT 0 CHECK (fnb_revenue_minor >= 0),
  occupancy_pct        numeric(5,2) CHECK (occupancy_pct IS NULL OR (occupancy_pct >= 0 AND occupancy_pct <= 100)),
  note                 text,
  updated_by           uuid,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, property_id, month)
);
ALTER TABLE budget_month ENABLE ROW LEVEL SECURITY; ALTER TABLE budget_month FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON budget_month USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON budget_month TO hos_admin; GRANT SELECT, INSERT, UPDATE ON budget_month TO hos_app;
