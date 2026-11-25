-- 0068 Finance step 6: a monthly budget per branch and account, so spending can be set against what was planned.
CREATE TABLE gl_budget (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid,
  account_id   uuid NOT NULL,
  month        date NOT NULL CHECK (month = date_trunc('month', month)::date),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  updated_by   uuid,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES gl_account (tenant_id, id)
);
CREATE UNIQUE INDEX gl_budget_uq ON gl_budget (tenant_id, coalesce(property_id, '00000000-0000-0000-0000-000000000000'::uuid), account_id, month);
ALTER TABLE gl_budget ENABLE ROW LEVEL SECURITY; ALTER TABLE gl_budget FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON gl_budget USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON gl_budget TO hos_admin; GRANT SELECT, INSERT, UPDATE, DELETE ON gl_budget TO hos_app;
