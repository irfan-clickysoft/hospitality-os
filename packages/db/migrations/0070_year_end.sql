-- 0070 Finance step 8: year-end close. The year's result moves to retained earnings through a closing voucher; a closed year cannot be posted into until it is reopened.
ALTER TABLE voucher DROP CONSTRAINT voucher_voucher_type_check;
ALTER TABLE voucher ADD CONSTRAINT voucher_voucher_type_check CHECK (voucher_type IN ('CRV','BRV','CPV','BPV','CTV','JV','IBEV','IBTV','PMS','SBV','SPV','YEC'));
ALTER TABLE gl_settings ADD COLUMN fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12);
CREATE TABLE fiscal_year_close (
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  fy_end     date NOT NULL,
  fy_start   date NOT NULL,
  voucher_id uuid NOT NULL,
  status     text NOT NULL CHECK (status IN ('PENDING','CLOSED','REOPENED')),
  closed_by  uuid,
  closed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, fy_end),
  CHECK (fy_end > fy_start),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id)
);
ALTER TABLE fiscal_year_close ENABLE ROW LEVEL SECURITY; ALTER TABLE fiscal_year_close FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON fiscal_year_close USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON fiscal_year_close TO hos_admin; GRANT SELECT, INSERT, UPDATE ON fiscal_year_close TO hos_app;
