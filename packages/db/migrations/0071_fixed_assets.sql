-- 0071 Finance step 10: fixed assets and the monthly depreciation run.
ALTER TABLE voucher DROP CONSTRAINT voucher_voucher_type_check;
ALTER TABLE voucher ADD CONSTRAINT voucher_voucher_type_check CHECK (voucher_type IN ('CRV','BRV','CPV','BPV','CTV','JV','IBEV','IBTV','PMS','SBV','SPV','YEC','DEP','DSP'));
ALTER TABLE gl_settings ADD COLUMN capitalisation_threshold_minor bigint NOT NULL DEFAULT 0 CHECK (capitalisation_threshold_minor >= 0);

CREATE TABLE fixed_asset (
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  seq                  integer NOT NULL,
  asset_no             text NOT NULL,
  name                 text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  category             text NOT NULL CHECK (category IN ('FURNITURE','EQUIPMENT','ELECTRONICS','VEHICLE','BUILDING_IMPROVEMENT','OTHER')),
  property_id          uuid NOT NULL,
  acquired_on          date NOT NULL,
  cost_minor           bigint NOT NULL CHECK (cost_minor > 0),
  salvage_minor        bigint NOT NULL DEFAULT 0 CHECK (salvage_minor >= 0),
  life_months          integer NOT NULL CHECK (life_months BETWEEN 1 AND 600),
  dep_from             date NOT NULL CHECK (dep_from = date_trunc('month', dep_from)::date),   -- the first month to depreciate
  opening_accum_minor  bigint NOT NULL DEFAULT 0 CHECK (opening_accum_minor >= 0),              -- already depreciated before the register started
  accumulated_minor    bigint NOT NULL DEFAULT 0 CHECK (accumulated_minor >= 0),               -- opening plus posted depreciation
  status               text NOT NULL DEFAULT 'IN_SERVICE' CHECK (status IN ('IN_SERVICE','DISPOSED')),
  disposal_voucher_id  uuid,
  disposed_on          date,
  serial_no            text CHECK (serial_no IS NULL OR length(serial_no) <= 80),
  note                 text CHECK (note IS NULL OR length(note) <= 300),
  created_by           uuid,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, seq),
  UNIQUE (tenant_id, asset_no),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK (salvage_minor < cost_minor),
  CHECK (opening_accum_minor <= cost_minor - salvage_minor)
);
CREATE TABLE depreciation_run (
  tenant_id   uuid NOT NULL REFERENCES tenant(id),
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  month       date NOT NULL CHECK (month = date_trunc('month', month)::date),
  voucher_id  uuid NOT NULL,
  voided      boolean NOT NULL DEFAULT false,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id)
);
CREATE UNIQUE INDEX depreciation_run_month_uq ON depreciation_run (tenant_id, month) WHERE NOT voided;
CREATE TABLE depreciation_line (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  run_id       uuid NOT NULL,
  asset_id     uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (tenant_id, run_id, asset_id),
  FOREIGN KEY (tenant_id, run_id) REFERENCES depreciation_run (tenant_id, id),
  FOREIGN KEY (tenant_id, asset_id) REFERENCES fixed_asset (tenant_id, id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['fixed_asset','depreciation_run','depreciation_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
