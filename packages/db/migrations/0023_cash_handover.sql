-- 0023 Weekly cash handover. Each register is counted and closed every day (an "envelope"); the envelopes stay in the property's safe; once a week the cash is handed to head office
-- (the CFO). This records every handover: how much the safe should hold, how much was handed over, to whom, and why they differ. Immutable.

INSERT INTO permission (key, description) VALUES
 ('cashier.handover', 'Record cash handed over from a property safe to head office')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE cash_handover (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  business_date    date NOT NULL,
  amount_minor     bigint NOT NULL CHECK (amount_minor > 0),
  safe_before_minor bigint NOT NULL,                     -- what the envelopes said the safe held just before this handover
  difference_minor bigint NOT NULL,                      -- amount − safe_before: zero when the safe was handed over in full
  received_by_name text NOT NULL CHECK (length(btrim(received_by_name)) BETWEEN 2 AND 120),
  received_by_title text,
  note             text,
  currency         char(3) NOT NULL,
  created_by       uuid NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK (difference_minor = amount_minor - safe_before_minor),
  CHECK (difference_minor = 0 OR length(btrim(coalesce(note,''))) >= 3)
);
CREATE INDEX cash_handover_idx ON cash_handover (tenant_id, property_id, created_at DESC);
CREATE TRIGGER cash_handover_append_only BEFORE UPDATE OR DELETE ON cash_handover FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER cash_handover_no_truncate BEFORE TRUNCATE ON cash_handover FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

ALTER TABLE cash_handover ENABLE ROW LEVEL SECURITY;
ALTER TABLE cash_handover FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cash_handover USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON cash_handover TO hos_admin;
GRANT SELECT, INSERT ON cash_handover TO hos_app;
