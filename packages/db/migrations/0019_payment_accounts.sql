-- 0019 Payment accounts: where every receipt actually lands. Cash drawers, company bank accounts, card and wallet clearing — and, when they exist, accounts owned by someone other than the company. Nothing is hidden; the other-owner accounts are flagged in every report.

CREATE TABLE payment_account (
  tenant_id     uuid NOT NULL REFERENCES tenant(id),
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid,                                          -- null = usable at every property
  kind          text NOT NULL CHECK (kind IN ('BANK','CARD_CLEARING','WALLET','GATEWAY')),
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  bank_name     text,
  account_title text,                                          -- the name the account is held in
  last4         char(4) CHECK (last4 IS NULL OR last4 ~ '^[0-9A-Za-z]{4}$'),
  owner_type    text NOT NULL DEFAULT 'COMPANY' CHECK (owner_type IN ('COMPANY','PERSONAL','OTHER')),
  owner_name    text,
  currency      char(3) NOT NULL DEFAULT 'PKR',
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','CLOSED')),
  note          text,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK (owner_type = 'COMPANY' OR length(btrim(coalesce(owner_name,''))) >= 2)        -- an account owned by anyone else must say whose
);
CREATE UNIQUE INDEX payment_account_name_uq ON payment_account (tenant_id, lower(btrim(name))) WHERE status = 'ACTIVE';

ALTER TABLE payment ADD COLUMN payment_account_id uuid;
ALTER TABLE payment ADD FOREIGN KEY (tenant_id, payment_account_id) REFERENCES payment_account (tenant_id, id);
ALTER TABLE ar_receipt ADD COLUMN payment_account_id uuid;
ALTER TABLE ar_receipt ADD FOREIGN KEY (tenant_id, payment_account_id) REFERENCES payment_account (tenant_id, id);
ALTER TABLE ota_receivable_event ADD COLUMN payment_account_id uuid;
ALTER TABLE ota_receivable_event ADD FOREIGN KEY (tenant_id, payment_account_id) REFERENCES payment_account (tenant_id, id);
CREATE INDEX payment_account_idx ON payment (tenant_id, payment_account_id) WHERE payment_account_id IS NOT NULL;

ALTER TABLE payment_account ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_account FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON payment_account USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON payment_account TO hos_admin;
GRANT SELECT, INSERT, UPDATE ON payment_account TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('paymentaccount.view',   'See payment accounts and the money received into each'),
 ('paymentaccount.manage', 'Add, change and close payment accounts')
ON CONFLICT (key) DO NOTHING;
