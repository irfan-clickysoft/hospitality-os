-- 0012 Tax engine (configuration only — no rates ship with the product) and invoices / credit notes.

ALTER TABLE property ADD COLUMN tax_jurisdiction text CHECK (tax_jurisdiction IS NULL OR tax_jurisdiction ~ '^[A-Z0-9_-]{2,30}$');
ALTER TABLE legal_entity ADD COLUMN fiscal_year_start_month smallint NOT NULL DEFAULT 1 CHECK (fiscal_year_start_month BETWEEN 1 AND 12);

-- A tax code is a name; its rates live in versions that are approved by a second person and carry the advisor's reference.
CREATE TABLE tax_code (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9_-]{2,30}$'),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  jurisdiction text NOT NULL CHECK (jurisdiction ~ '^[A-Z0-9_-]{2,30}$'),
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE TABLE tax_code_version (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  tax_code_id         uuid NOT NULL,
  version_no          integer NOT NULL,
  status              text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','REJECTED','RETIRED')),
  rate_bp             integer NOT NULL CHECK (rate_bp BETWEEN 0 AND 10000),               -- basis points: 1600 = 16.00%
  applies_to          text[] NOT NULL CHECK (cardinality(applies_to) > 0),                  -- transaction codes this tax is charged on
  residency           text CHECK (residency IN ('RESIDENT','NON_RESIDENT')),                -- null = both
  determination_point text NOT NULL DEFAULT 'ON_POSTING' CHECK (determination_point IN ('ON_POSTING')),
  input_tax_treatment text NOT NULL DEFAULT 'NOT_APPLICABLE' CHECK (input_tax_treatment IN ('RECOVERABLE','NOT_RECOVERABLE','NOT_APPLICABLE')),
  effective_from      date NOT NULL,
  effective_to        date,
  legal_basis         text,
  advisor_ref         text,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  approved_by         uuid,
  approved_at         timestamptz,
  decision_note       text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, tax_code_id, version_no),
  FOREIGN KEY (tenant_id, tax_code_id) REFERENCES tax_code (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_to >= effective_from),
  CHECK (approved_by IS NULL OR approved_by <> created_by),                                -- maker–checker: nobody approves their own rate
  CHECK (status <> 'ACTIVE' OR (approved_by IS NOT NULL AND length(btrim(coalesce(advisor_ref,''))) > 0 AND length(btrim(coalesce(legal_basis,''))) > 0)),
  EXCLUDE USING gist (tax_code_id WITH =, daterange(effective_from, coalesce(effective_to + 1, 'infinity'::date)) WITH &&) WHERE (status = 'ACTIVE')     -- one rate at a time per code
);

-- Postings that share a timestamp (a charge and its tax) still have one definite order.
ALTER TABLE folio_posting ADD COLUMN seq bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX folio_posting_seq_idx ON folio_posting (tenant_id, folio_id, seq);

-- What a tax posting records about how it was worked out (so a later rate change never restates history).
ALTER TABLE folio_posting
  ADD COLUMN tax_code       text,
  ADD COLUMN tax_version_id uuid,
  ADD COLUMN tax_rate_bp    integer,
  ADD COLUMN taxable_minor  bigint;
ALTER TABLE folio_posting ADD FOREIGN KEY (tenant_id, tax_version_id) REFERENCES tax_code_version (tenant_id, id);
CREATE INDEX folio_posting_tax_idx ON folio_posting (tenant_id, property_id, business_date) WHERE tax_code IS NOT NULL;

-- The night audit's snapshot gains the tax of the day.
ALTER TABLE daily_property_stats ADD COLUMN tax_minor bigint NOT NULL DEFAULT 0;

-- Invoices and credit notes: immutable legal documents with gapless numbers per legal entity, series and fiscal year.
CREATE TABLE invoice_counter (
  tenant_id       uuid NOT NULL,
  legal_entity_id uuid NOT NULL,
  series          text NOT NULL,
  fiscal_year     integer NOT NULL,
  last_seq        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, legal_entity_id, series, fiscal_year),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entity (tenant_id, id)
);
CREATE TABLE invoice (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL,
  legal_entity_id    uuid NOT NULL,
  folio_id           uuid NOT NULL,
  reservation_id     uuid,
  doc_type           text NOT NULL CHECK (doc_type IN ('TAX_INVOICE','CREDIT_NOTE')),
  series             text NOT NULL,
  fiscal_year        integer NOT NULL,
  seq                integer NOT NULL,
  number             text NOT NULL,
  issue_date         date NOT NULL,                      -- the property's business date
  issued_at          timestamptz NOT NULL DEFAULT now(),
  currency           char(3) NOT NULL,
  issuer             jsonb NOT NULL,                     -- legal entity details as they were
  bill_to            jsonb NOT NULL,
  lines              jsonb NOT NULL,
  tax_summary        jsonb NOT NULL,
  payments           jsonb NOT NULL,
  reference          jsonb NOT NULL DEFAULT '{}'::jsonb,   -- booking number, folio, stay dates, rooms; for a credit note, the invoice it reverses
  net_minor          bigint NOT NULL,                    -- credit notes carry negative amounts
  tax_minor          bigint NOT NULL,
  total_minor        bigint NOT NULL,
  credits_invoice_id uuid,
  reason             text,
  content_hash       text NOT NULL,
  issued_by          uuid NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (tenant_id, legal_entity_id, number),
  UNIQUE (tenant_id, legal_entity_id, series, fiscal_year, seq),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, legal_entity_id) REFERENCES legal_entity (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, credits_invoice_id) REFERENCES invoice (tenant_id, id),
  CHECK (net_minor + tax_minor = total_minor),
  CHECK ((doc_type = 'CREDIT_NOTE') = (credits_invoice_id IS NOT NULL)),
  CHECK (doc_type = 'CREDIT_NOTE' OR (net_minor >= 0 AND total_minor >= 0)),
  CHECK (doc_type = 'TAX_INVOICE' OR (net_minor <= 0 AND total_minor <= 0))
);
CREATE UNIQUE INDEX invoice_one_credit ON invoice (tenant_id, credits_invoice_id) WHERE credits_invoice_id IS NOT NULL;
CREATE INDEX invoice_folio_idx ON invoice (tenant_id, folio_id);
CREATE INDEX invoice_reservation_idx ON invoice (tenant_id, reservation_id);
CREATE TABLE invoice_posting (
  tenant_id  uuid NOT NULL,
  invoice_id uuid NOT NULL,
  posting_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, invoice_id, posting_id),
  FOREIGN KEY (tenant_id, invoice_id) REFERENCES invoice (tenant_id, id),
  FOREIGN KEY (tenant_id, posting_id) REFERENCES folio_posting (tenant_id, id)
);
CREATE INDEX invoice_posting_posting_idx ON invoice_posting (tenant_id, posting_id);
CREATE TRIGGER invoice_append_only BEFORE UPDATE OR DELETE ON invoice FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER invoice_no_truncate BEFORE TRUNCATE ON invoice FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER invoice_posting_append_only BEFORE UPDATE OR DELETE ON invoice_posting FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER invoice_posting_no_truncate BEFORE TRUNCATE ON invoice_posting FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tax_code','tax_code_version','invoice_counter','invoice','invoice_posting'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON tax_code, tax_code_version, invoice_counter TO hos_app;
GRANT SELECT, INSERT ON invoice, invoice_posting TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('invoice.issue',  'Issue tax invoices'),
 ('invoice.credit', 'Issue a credit note against an invoice')
ON CONFLICT (key) DO NOTHING;

-- A tax line follows its charge: negative for a discount, zero for a zero-rated charge (the taxable value is still recorded), reversible like any posting.
DO $$
DECLARE c text;
BEGIN
  SELECT conname INTO c FROM pg_constraint WHERE conrelid = 'folio_posting'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%DEPOSIT_RECEIVED%';
  EXECUTE format('ALTER TABLE folio_posting DROP CONSTRAINT %I', c);
END $$;
ALTER TABLE folio_posting ADD CONSTRAINT folio_posting_sign_check CHECK (CASE posting_type
  WHEN 'CHARGE' THEN amount_minor > 0 WHEN 'REFUND' THEN amount_minor > 0 WHEN 'DISCOUNT' THEN amount_minor < 0 WHEN 'PAYMENT' THEN amount_minor < 0 WHEN 'DEPOSIT_RECEIVED' THEN amount_minor < 0
  WHEN 'TAX' THEN true WHEN 'REVERSAL' THEN true ELSE amount_minor <> 0 END);
