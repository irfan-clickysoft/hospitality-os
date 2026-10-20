-- 0029 Wording of the messages sent to guests (WhatsApp and email), editable by the owner. A missing row means "use the built-in wording", so nothing has to be seeded.
-- Receipt numbers: every payment gets one, per property and year, never reused.

CREATE TABLE message_template (
  tenant_id  uuid NOT NULL,
  event      text NOT NULL CHECK (event IN ('RESERVATION_CONFIRMED','CHECK_IN','PAYMENT_RECEIVED','SERVICE_ORDER','CHECK_OUT','REFUND','DOCUMENT')),
  channel    text NOT NULL CHECK (channel IN ('WHATSAPP','EMAIL')),
  subject    text CHECK (subject IS NULL OR length(subject) <= 200),
  body       text NOT NULL CHECK (length(btrim(body)) BETWEEN 10 AND 4000),
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, event, channel)
);
ALTER TABLE message_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_template FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_template USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON message_template TO hos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON message_template TO hos_app;

ALTER TABLE payment ADD COLUMN receipt_no text;
CREATE UNIQUE INDEX payment_receipt_no_idx ON payment (tenant_id, property_id, receipt_no) WHERE receipt_no IS NOT NULL;
