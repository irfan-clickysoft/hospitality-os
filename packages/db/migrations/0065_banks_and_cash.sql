-- 0065 Finance step 3: bank accounts with the branches that use them, a ledger account and a recorded authorisation; branch cash and petty cash drawers with daily closing.
INSERT INTO permission (key, description) VALUES
 ('finance.bank_details', 'See a bank account''s full IBAN and account number, and authorise accounts held in someone else''s name')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE payment_account
  ADD COLUMN account_type  text CHECK (account_type IS NULL OR account_type IN ('CURRENT','SAVINGS','OTHER')),
  ADD COLUMN purpose       text CHECK (purpose IS NULL OR purpose IN ('COLLECTIONS','EXPENSES','BOTH','PAYROLL','REFUNDS','OTHER')),
  ADD COLUMN gl_account_id uuid,
  ADD COLUMN authorised_by uuid,
  ADD COLUMN authorised_at timestamptz,
  ADD COLUMN authorisation_note text CHECK (authorisation_note IS NULL OR length(authorisation_note) <= 500),
  ADD FOREIGN KEY (tenant_id, gl_account_id) REFERENCES gl_account (tenant_id, id);
CREATE UNIQUE INDEX payment_account_gl_uq ON payment_account (tenant_id, gl_account_id) WHERE gl_account_id IS NOT NULL;

CREATE TABLE payment_account_branch (
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  payment_account_id uuid NOT NULL,
  property_id        uuid NOT NULL,
  PRIMARY KEY (tenant_id, payment_account_id, property_id),
  FOREIGN KEY (tenant_id, payment_account_id) REFERENCES payment_account (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);

CREATE TABLE cash_drawer (
  tenant_id           uuid NOT NULL REFERENCES tenant(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('CASH','PETTY')),
  name                text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  custodian_user_id   uuid,
  opening_float_minor bigint NOT NULL DEFAULT 0 CHECK (opening_float_minor >= 0),
  max_limit_minor     bigint CHECK (max_limit_minor IS NULL OR max_limit_minor > 0),
  status              text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, custodian_user_id) REFERENCES staff_user (tenant_id, id)
);
CREATE UNIQUE INDEX cash_drawer_one_uq ON cash_drawer (tenant_id, property_id, kind) WHERE status = 'ACTIVE';

CREATE TABLE cash_closing (
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  drawer_id       uuid NOT NULL,
  business_date   date NOT NULL,
  expected_minor  bigint NOT NULL,
  counted_minor   bigint NOT NULL CHECK (counted_minor >= 0),
  variance_minor  bigint NOT NULL,
  note            text CHECK (note IS NULL OR length(note) <= 500),
  status          text NOT NULL CHECK (status IN ('CLOSED','PENDING_APPROVAL','APPROVED','REJECTED')),
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_by      uuid,
  decided_at      timestamptz,
  decision_note   text,
  voucher_id      uuid,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, drawer_id, business_date),
  FOREIGN KEY (tenant_id, drawer_id) REFERENCES cash_drawer (tenant_id, id),
  CHECK (variance_minor = counted_minor - expected_minor),
  CHECK (variance_minor = 0 OR length(btrim(coalesce(note,''))) >= 3)
);

ALTER TABLE gl_posting_map DROP CONSTRAINT gl_posting_map_key_check;
ALTER TABLE gl_posting_map ADD CONSTRAINT gl_posting_map_key_check CHECK (key ~ '^(GUEST_LEDGER|ADVANCE|CASH|PETTY|SHORTOVER|CARD|WALLET|BANK_TRANSFER|AR|OTA|TAX|WHT|REV:[A-Z_]+|PAYACC:[0-9a-f-]{36})$');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payment_account_branch','cash_drawer','cash_closing'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
GRANT DELETE ON payment_account_branch TO hos_app;
