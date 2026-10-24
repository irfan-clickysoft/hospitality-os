-- 0042 What happened to an email after the mail service accepted it. Amazon tells us (through a notification) when a message was delivered, bounced or reported as spam.
-- A permanent bounce or a complaint puts the address on a list the system will not send to again until someone with authority lifts it.
ALTER TABLE email_message DROP CONSTRAINT email_message_status_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_status_check CHECK (status IN ('QUEUED','SENT','FAILED','DELIVERED','BOUNCED','COMPLAINED'));
ALTER TABLE email_message ADD COLUMN feedback text CHECK (feedback IS NULL OR length(feedback) <= 400), ADD COLUMN feedback_at timestamptz;
CREATE UNIQUE INDEX email_message_provider_uq ON email_message (provider_id) WHERE provider_id IS NOT NULL;

CREATE TABLE email_suppression (
  tenant_id  uuid NOT NULL,
  address    text NOT NULL CHECK (address = lower(address) AND length(address) <= 254),
  reason     text NOT NULL CHECK (reason IN ('BOUNCE','COMPLAINT')),
  detail     text CHECK (detail IS NULL OR length(detail) <= 400),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, address)
);
ALTER TABLE email_suppression ENABLE ROW LEVEL SECURITY;
ALTER TABLE email_suppression FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON email_suppression USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON email_suppression TO hos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON email_suppression TO hos_app;
