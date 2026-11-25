-- 0064 Finance step 2: money the PMS already handles (guest payments, deposits, charges, taxes, refunds, company and OTA receipts) is posted to the ledger automatically.
ALTER TABLE voucher DROP CONSTRAINT voucher_voucher_type_check;
ALTER TABLE voucher ADD CONSTRAINT voucher_voucher_type_check CHECK (voucher_type IN ('CRV','BRV','CPV','BPV','CTV','JV','IBEV','IBTV','PMS'));

ALTER TABLE gl_settings ADD COLUMN pms_posting_from date;     -- null = automatic posting is off; folio entries dated from this day are posted

CREATE TABLE gl_posting_map (          -- which ledger account each kind of PMS money lands in
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  key        text NOT NULL CHECK (key ~ '^(GUEST_LEDGER|ADVANCE|CASH|CARD|WALLET|BANK_TRANSFER|AR|OTA|TAX|WHT|REV:[A-Z_]+|PAYACC:[0-9a-f-]{36})$'),
  account_id uuid NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key),
  FOREIGN KEY (tenant_id, account_id) REFERENCES gl_account (tenant_id, id)
);

CREATE TABLE finance_exception (       -- a PMS event that could not be posted; the PMS action itself was not blocked
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid,
  source_module   text NOT NULL,
  source_event_id text NOT NULL,
  reason          text NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','RESOLVED')),
  attempts        integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, source_module, source_event_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['gl_posting_map','finance_exception'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
GRANT DELETE ON gl_posting_map TO hos_app;
