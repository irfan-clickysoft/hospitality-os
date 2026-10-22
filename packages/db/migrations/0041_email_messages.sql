-- 0041 Email sending. Every email the system sends for the business (a receipt, a booking confirmation, a company statement) is recorded with who sent it, to whom, and whether the mail service accepted it.
CREATE TABLE email_message (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  purpose      text NOT NULL CHECK (purpose IN ('GUEST','COMPANY')),
  ref_id       uuid,                                           -- the booking or the company
  to_address   text NOT NULL CHECK (length(to_address) <= 254),
  subject      text NOT NULL CHECK (length(subject) <= 200),
  body         text NOT NULL CHECK (length(body) <= 8000),
  status       text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED')),
  provider_id  text,
  error        text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE INDEX email_message_recent_idx ON email_message (tenant_id, property_id, created_at DESC);
ALTER TABLE email_message ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_message FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_message USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON email_message TO hos_admin;
GRANT SELECT, INSERT, UPDATE ON email_message TO hos_app;
