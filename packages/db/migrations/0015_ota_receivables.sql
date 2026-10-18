-- 0015 OTA receivables: a cancellation or no-show fee that the OTA (not the guest) owes the property.
-- Claiming it moves the amount off the guest's folio into a receivable that is chased, received, disputed or written off, with every step recorded.

CREATE TABLE ota_receivable (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  reservation_id   uuid NOT NULL,
  folio_id         uuid NOT NULL,
  posting_id       uuid NOT NULL,                          -- the posting that took the amount off the guest's folio
  source           text NOT NULL CHECK (source IN ('OTA_BOOKING_COM','OTA_OTHER')),
  ota_ref          text,                                   -- the OTA's own booking number
  confirmation_no  text NOT NULL,
  guest_name       text,
  kind             text NOT NULL CHECK (kind IN ('NO_SHOW','LATE_CANCELLATION','OTHER')),
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  received_minor   bigint NOT NULL DEFAULT 0 CHECK (received_minor >= 0),
  written_off_minor bigint NOT NULL DEFAULT 0 CHECK (written_off_minor >= 0),
  currency         char(3) NOT NULL,
  status           text NOT NULL DEFAULT 'CLAIMABLE' CHECK (status IN ('CLAIMABLE','CLAIMED','RECEIVED','DISPUTED','WRITTEN_OFF','VOID')),
  claim_ref        text,
  claimed_on       date,
  incurred_on      date NOT NULL,                          -- the business date it was moved off the guest's bill (the ageing starts here)
  note             text,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, posting_id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, posting_id) REFERENCES folio_posting (tenant_id, id),
  CHECK (received_minor + written_off_minor <= amount_minor)
);
CREATE INDEX ota_receivable_prop_idx ON ota_receivable (tenant_id, property_id, status);
CREATE INDEX ota_receivable_res_idx ON ota_receivable (tenant_id, reservation_id);

CREATE TABLE ota_receivable_event (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  receivable_id  uuid NOT NULL,
  action         text NOT NULL CHECK (action IN ('CREATE','CLAIM','RECEIVE','DISPUTE','RESOLVE','WRITE_OFF','VOID')),
  amount_minor   bigint,
  reference      text,
  note           text,
  business_date  date NOT NULL,
  actor_id       uuid NOT NULL,
  at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, receivable_id) REFERENCES ota_receivable (tenant_id, id)
);
CREATE INDEX ota_receivable_event_idx ON ota_receivable_event (tenant_id, receivable_id, at);
CREATE TRIGGER ota_receivable_event_append_only BEFORE UPDATE OR DELETE ON ota_receivable_event FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER ota_receivable_event_no_truncate BEFORE TRUNCATE ON ota_receivable_event FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ota_receivable','ota_receivable_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON ota_receivable TO hos_app;
GRANT SELECT, INSERT ON ota_receivable_event TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('ota.claim',    'Move an OTA-liable fee onto an OTA claim, record claims and money received'),
 ('ota.writeoff', 'Write off an OTA claim that will not be paid')
ON CONFLICT (key) DO NOTHING;
