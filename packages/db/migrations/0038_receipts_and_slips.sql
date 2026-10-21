-- 0038 Branded documents and bank-transfer slips. A property has a look (logo, colour, address, phone, a line for the foot of every receipt); a receipt, a refund voucher, a final statement or a
-- room-service slip can be opened by staff, or by a guest through a private link; and a bank-transfer slip (a picture or PDF of the transfer) can be uploaded by the guest or the desk and
-- is kept private, attached to the booking and, once the money is recorded, to the payment.

ALTER TABLE property
  ADD COLUMN logo_file      text CHECK (logo_file IS NULL OR logo_file ~ '^[0-9a-f]{32}\.(jpg|png|webp)$'),
  ADD COLUMN brand_color    text CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$'),
  ADD COLUMN address        text CHECK (address IS NULL OR length(address) <= 300),
  ADD COLUMN phone          text CHECK (phone IS NULL OR length(phone) <= 40),
  ADD COLUMN receipt_footer text CHECK (receipt_footer IS NULL OR length(receipt_footer) <= 300);

CREATE TABLE document_link (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('PAYMENT','STATEMENT','ORDER')),
  ref_id         uuid NOT NULL,                                       -- the payment, the reservation or the order
  token          text NOT NULL UNIQUE CHECK (token ~ '^[0-9a-f]{32}-[0-9a-f]{32}$'),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz,
  revoked_at     timestamptz,
  views          integer NOT NULL DEFAULT 0,
  last_viewed_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE UNIQUE INDEX document_link_live_uq ON document_link (tenant_id, kind, ref_id) WHERE revoked_at IS NULL;

CREATE TABLE payment_slip (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  reservation_id       uuid,                                          -- a slip for a conference hire or a company bill has no booking
  payment_id           uuid,
  source               text NOT NULL CHECK (source IN ('GUEST','STAFF')),
  file_name            text NOT NULL,
  content_type         text NOT NULL,
  size_bytes           bigint NOT NULL CHECK (size_bytes > 0),
  claimed_amount_minor bigint CHECK (claimed_amount_minor IS NULL OR claimed_amount_minor > 0),    -- what the guest says they sent
  reference            text CHECK (reference IS NULL OR length(reference) <= 80),
  bank                 text CHECK (bank IS NULL OR length(bank) <= 80),
  note                 text CHECK (note IS NULL OR length(note) <= 300),
  status               text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','LINKED','REJECTED')),
  reject_reason        text,
  handled_by           uuid,
  handled_at           timestamptz,
  submitted_by         uuid,
  submitted_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservation (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id),
  CHECK (reservation_id IS NOT NULL OR payment_id IS NOT NULL)
);
CREATE INDEX payment_slip_open_idx ON payment_slip (tenant_id, property_id, status, submitted_at);
CREATE INDEX payment_slip_payment_idx ON payment_slip (tenant_id, payment_id) WHERE payment_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['document_link','payment_slip'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
