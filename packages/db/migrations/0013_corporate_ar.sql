-- 0013 Corporate accounts and accounts receivable: companies on credit, what they owe, what they have paid, and the ageing.
-- The receivable is its own sub-ledger. Billing a stay to a company moves the amount off the guest's folio (a posting) and into an AR item here.

CREATE TABLE company (
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 160),
  ntn               text,
  strn              text,
  address           text,
  contact_name      text,
  contact_phone     text,
  contact_email     text,
  currency          char(3) NOT NULL DEFAULT 'PKR',
  credit_limit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_limit_minor >= 0),        -- 0 = no credit: nothing can be billed to the company
  terms_days        integer NOT NULL DEFAULT 30 CHECK (terms_days BETWEEN 0 AND 365),   -- net days from the billing date
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ON_HOLD','ARCHIVED')),
  hold_reason       text,
  notes             text,
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT now(),
  version           integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX company_name_uq ON company (tenant_id, lower(btrim(name))) WHERE status <> 'ARCHIVED';

ALTER TABLE reservation ADD CONSTRAINT reservation_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id) NOT VALID;
ALTER TABLE folio ADD CONSTRAINT folio_company_fk FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id) NOT VALID;

-- One row per amount billed to a company. Never edited; cancelling it is a separate row (ar_item_void).
CREATE TABLE ar_item (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  company_id     uuid NOT NULL,
  folio_id       uuid NOT NULL,
  reservation_id uuid,
  posting_id     uuid NOT NULL,                       -- the posting that took the amount off the guest's folio
  amount_minor   bigint NOT NULL CHECK (amount_minor > 0),
  currency       char(3) NOT NULL,
  item_date      date NOT NULL,
  due_date       date NOT NULL,
  confirmation_no text,
  guest_name     text,
  note           text,
  override_reason text,                               -- set when billed above the credit limit or while on hold
  created_by     uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, posting_id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, posting_id) REFERENCES folio_posting (tenant_id, id),
  CHECK (due_date >= item_date)
);
CREATE INDEX ar_item_company_idx ON ar_item (tenant_id, company_id, due_date);
CREATE INDEX ar_item_reservation_idx ON ar_item (tenant_id, reservation_id);

CREATE TABLE ar_item_void (
  tenant_id  uuid NOT NULL,
  item_id    uuid NOT NULL,
  reason     text NOT NULL CHECK (length(btrim(reason)) >= 3),
  void_date  date NOT NULL,                       -- the property's business date
  voided_by  uuid NOT NULL,
  voided_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ar_item (tenant_id, id)
);

-- Money received from a company. A second person verifies it; only then does it reduce what is owed.
CREATE TABLE ar_receipt (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id      uuid NOT NULL,
  method          text NOT NULL CHECK (method IN ('BANK_TRANSFER','CHEQUE','WALLET')),
  amount_minor    bigint NOT NULL CHECK (amount_minor > 0),               -- money actually received
  withheld_minor  bigint NOT NULL DEFAULT 0 CHECK (withheld_minor >= 0),  -- tax the company withheld and will certify; it also settles what is owed
  withholding_ref text,                                                   -- the certificate / challan the company gave
  currency        char(3) NOT NULL,
  reference       text NOT NULL CHECK (length(btrim(reference)) >= 3),
  counterparty    text,
  received_on     date NOT NULL,
  apply_to        uuid[] NOT NULL DEFAULT '{}',                          -- items to settle first; the rest oldest-due first
  status          text NOT NULL DEFAULT 'PENDING_VERIFICATION' CHECK (status IN ('PENDING_VERIFICATION','CAPTURED','REJECTED')),
  note            text,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  verified_by     uuid,
  verified_at     timestamptz,
  decision_note   text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, company_id) REFERENCES company (tenant_id, id),
  CHECK (verified_by IS NULL OR verified_by <> created_by),                 -- maker–checker
  CHECK (withheld_minor = 0 OR length(btrim(coalesce(withholding_ref,''))) > 0)
);
CREATE UNIQUE INDEX ar_receipt_ref_uq ON ar_receipt (tenant_id, company_id, method, lower(btrim(reference))) WHERE status <> 'REJECTED';
CREATE INDEX ar_receipt_company_idx ON ar_receipt (tenant_id, company_id, received_on);

CREATE TABLE ar_allocation (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  receipt_id    uuid NOT NULL,
  item_id       uuid NOT NULL,
  applied_minor bigint NOT NULL CHECK (applied_minor > 0),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, receipt_id) REFERENCES ar_receipt (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES ar_item (tenant_id, id)
);
CREATE INDEX ar_allocation_item_idx ON ar_allocation (tenant_id, item_id);
CREATE INDEX ar_allocation_receipt_idx ON ar_allocation (tenant_id, receipt_id);

CREATE TRIGGER ar_item_append_only BEFORE UPDATE OR DELETE ON ar_item FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ar_item_no_truncate BEFORE TRUNCATE ON ar_item FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ar_item_void_append_only BEFORE UPDATE OR DELETE ON ar_item_void FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ar_item_void_no_truncate BEFORE TRUNCATE ON ar_item_void FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ar_allocation_append_only BEFORE UPDATE OR DELETE ON ar_allocation FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ar_allocation_no_truncate BEFORE TRUNCATE ON ar_allocation FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['company','ar_item','ar_item_void','ar_receipt','ar_allocation'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON company, ar_receipt TO hos_app;
GRANT SELECT, INSERT ON ar_item, ar_item_void, ar_allocation TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('company.view',        'See corporate accounts and what they owe'),
 ('company.manage',      'Create and edit corporate accounts, put them on hold'),
 ('ar.bill',             'Bill a guest''s stay to a corporate account'),
 ('ar.override_credit',  'Bill above a company''s credit limit or while it is on hold'),
 ('ar.receipt',          'Record money received from a corporate account'),
 ('ar.verify',           'Verify money received from a corporate account')
ON CONFLICT (key) DO NOTHING;
