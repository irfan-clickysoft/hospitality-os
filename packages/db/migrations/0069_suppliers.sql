-- 0069 Finance step 7: suppliers and what is owed to them. A bill and a payment are vouchers (so they need a second person), and every ledger line on the payables account names the supplier.
ALTER TABLE voucher DROP CONSTRAINT voucher_voucher_type_check;
ALTER TABLE voucher ADD CONSTRAINT voucher_voucher_type_check CHECK (voucher_type IN ('CRV','BRV','CPV','BPV','CTV','JV','IBEV','IBTV','PMS','SBV','SPV'));

CREATE TABLE supplier (
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  legal_name         text CHECK (legal_name IS NULL OR length(legal_name) <= 160),
  contact_name       text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  phone              text CHECK (phone IS NULL OR length(phone) <= 40),
  email              text CHECK (email IS NULL OR length(email) <= 160),
  ntn                text CHECK (ntn IS NULL OR length(ntn) <= 30),
  payment_terms_days integer NOT NULL DEFAULT 30 CHECK (payment_terms_days BETWEEN 0 AND 365),
  bank_name          text CHECK (bank_name IS NULL OR length(bank_name) <= 80),
  account_title      text CHECK (account_title IS NULL OR length(account_title) <= 120),
  iban               text CHECK (iban IS NULL OR iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  account_number     text CHECK (account_number IS NULL OR account_number ~ '^[0-9A-Za-z -]{4,34}$'),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  note               text CHECK (note IS NULL OR length(note) <= 300),
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX supplier_name_uq ON supplier (tenant_id, lower(name));

ALTER TABLE voucher_line ADD COLUMN supplier_id uuid, ADD FOREIGN KEY (tenant_id, supplier_id) REFERENCES supplier (tenant_id, id);
ALTER TABLE gl_entry ADD COLUMN supplier_id uuid;
CREATE INDEX gl_entry_supplier_idx ON gl_entry (tenant_id, supplier_id) WHERE supplier_id IS NOT NULL;

CREATE TABLE supplier_bill (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL,
  property_id  uuid NOT NULL,
  bill_no      text NOT NULL CHECK (length(btrim(bill_no)) BETWEEN 1 AND 60),
  bill_date    date NOT NULL,
  due_date     date NOT NULL,
  total_minor  bigint NOT NULL CHECK (total_minor > 0),
  paid_minor   bigint NOT NULL DEFAULT 0 CHECK (paid_minor >= 0 AND paid_minor <= total_minor),
  voucher_id   uuid NOT NULL,
  narration    text NOT NULL CHECK (length(narration) <= 500),
  reversed     boolean NOT NULL DEFAULT false,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, supplier_id, bill_no),                     -- the same invoice cannot be entered twice
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id)
);
CREATE TABLE supplier_payment (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  supplier_id  uuid NOT NULL,
  property_id  uuid NOT NULL,
  paid_on      date NOT NULL,
  total_minor  bigint NOT NULL CHECK (total_minor > 0),
  reference    text CHECK (reference IS NULL OR length(reference) <= 120),
  voucher_id   uuid NOT NULL,
  created_by   uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id)
);
CREATE TABLE supplier_payment_alloc (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  payment_id   uuid NOT NULL,
  bill_id      uuid NOT NULL,
  amount_minor bigint NOT NULL CHECK (amount_minor > 0),
  PRIMARY KEY (tenant_id, payment_id, bill_id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES supplier_payment (tenant_id, id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES supplier_bill (tenant_id, id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['supplier','supplier_bill','supplier_payment','supplier_payment_alloc'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
