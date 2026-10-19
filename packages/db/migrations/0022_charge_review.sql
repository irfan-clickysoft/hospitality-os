-- 0022 Charge reviews and digital food payments.
-- A review rule says: in this tax area, a charge with this code needs someone to look at it (Islamabad: a withholding-tax review of third-party transport;
-- Karachi: verifying the vendor). Posting such a charge opens a review; someone with the right permission closes it with a note. Rules are data, set per tax area.
-- A kitchen order says up front whether it will be paid digitally: it is then charged (and taxed) as FNB_DIGITAL rather than FNB.

ALTER TABLE fnb_order ADD COLUMN pay_digital boolean NOT NULL DEFAULT false;

CREATE TABLE charge_review_rule (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  jurisdiction  text NOT NULL CHECK (length(btrim(jurisdiction)) BETWEEN 2 AND 30),   -- the same key as a property's tax area
  txn_code      text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('WHT_REVIEW','VENDOR_VERIFICATION')),
  message       text NOT NULL CHECK (length(btrim(message)) BETWEEN 3 AND 300),
  active        boolean NOT NULL DEFAULT true,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, jurisdiction, txn_code, kind)
);

CREATE TABLE charge_review (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  folio_id      uuid NOT NULL,
  posting_id    uuid NOT NULL,
  kind          text NOT NULL,
  txn_code      text NOT NULL,
  message       text NOT NULL,
  amount_minor  bigint NOT NULL,
  currency      char(3) NOT NULL,
  description   text,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  resolved_by   uuid,
  resolved_at   timestamptz,
  note          text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, posting_id, kind),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, posting_id) REFERENCES folio_posting (tenant_id, id),
  CHECK ((status = 'DONE') = (resolved_at IS NOT NULL)),
  CHECK (status = 'OPEN' OR length(btrim(coalesce(note,''))) >= 3)
);
CREATE INDEX charge_review_open_idx ON charge_review (tenant_id, property_id, status, opened_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['charge_review_rule','charge_review'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON charge_review_rule, charge_review TO hos_app;
