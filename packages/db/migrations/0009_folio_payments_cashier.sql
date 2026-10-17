-- 0009 Folios, the immutable posting ledger, payments (manual tenders) and cashier sessions.
-- Sign convention: charges are positive, payments / discounts / deposits are negative. A folio balance is the sum of its postings (positive = guest owes).

CREATE TABLE cashier_session (
  tenant_id            uuid NOT NULL,
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id          uuid NOT NULL,
  register_name        text NOT NULL DEFAULT 'Front desk' CHECK (length(btrim(register_name)) BETWEEN 1 AND 60),
  user_id              uuid NOT NULL,
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','REVIEWED')),
  opened_at            timestamptz NOT NULL DEFAULT now(),
  opened_business_date date NOT NULL,
  opening_float_minor  bigint NOT NULL DEFAULT 0 CHECK (opening_float_minor >= 0),
  closed_at            timestamptz,
  counted_minor        bigint CHECK (counted_minor >= 0),
  expected_minor       bigint,                         -- fixed at close; hidden from the cashier until the count is submitted (blind close)
  variance_minor       bigint,                         -- counted − expected
  close_note           text,
  reviewed_by          uuid,
  reviewed_at          timestamptz,
  review_note          text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES staff_user (tenant_id, id)
);
CREATE UNIQUE INDEX cashier_one_open_per_user ON cashier_session (tenant_id, property_id, user_id) WHERE status = 'OPEN';
CREATE INDEX cashier_session_prop_idx ON cashier_session (tenant_id, property_id, opened_at DESC);

CREATE TABLE cash_drop (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL,
  cashier_session_id uuid NOT NULL,
  amount_minor       bigint NOT NULL CHECK (amount_minor > 0),
  note               text,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cashier_session_id) REFERENCES cashier_session (tenant_id, property_id, id)
);

CREATE TABLE folio (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  folio_no        text NOT NULL,
  folio_type      text NOT NULL DEFAULT 'GUEST' CHECK (folio_type IN ('GUEST','MASTER','COMPANY','HOUSE')),
  reservation_id  uuid,
  guest_id        uuid,
  company_id      uuid,
  currency        char(3) NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','CLOSED','VOID')),
  balance_minor   bigint NOT NULL DEFAULT 0,           -- maintained by trigger from the postings; verified by the invariant checker
  closed_at       timestamptz,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (tenant_id, property_id, folio_no),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, guest_id) REFERENCES guest (tenant_id, id)
);
CREATE UNIQUE INDEX folio_one_guest_folio ON folio (tenant_id, reservation_id) WHERE folio_type = 'GUEST' AND status <> 'VOID';
CREATE INDEX folio_open_idx ON folio (tenant_id, property_id, status);

CREATE TABLE payment (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL,
  folio_id            uuid NOT NULL,
  kind                text NOT NULL CHECK (kind IN ('PAYMENT','DEPOSIT','REFUND')),
  method              text NOT NULL CHECK (method IN ('CASH','BANK_TRANSFER','CARD_SLIP','WALLET')),
  status              text NOT NULL CHECK (status IN ('PENDING_VERIFICATION','CAPTURED','REJECTED','VOIDED')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL,
  reference           text,                              -- bank reference / RRN / wallet transaction id
  card_last4          char(4),
  approval_code       text,
  counterparty        text,                              -- bank or wallet name; for refunds, the beneficiary
  note                text,
  refund_of_payment_id uuid,
  cashier_session_id  uuid,
  business_date       date NOT NULL,
  created_by          uuid NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  verified_by         uuid,
  verified_at         timestamptz,
  void_reason         text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, refund_of_payment_id) REFERENCES payment (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, cashier_session_id) REFERENCES cashier_session (tenant_id, property_id, id),
  CHECK ((kind = 'REFUND') = (refund_of_payment_id IS NOT NULL)),
  CHECK (verified_by IS NULL OR verified_by <> created_by)       -- maker–checker: nobody verifies their own entry
);
CREATE INDEX payment_folio_idx ON payment (tenant_id, folio_id);
CREATE INDEX payment_session_idx ON payment (tenant_id, cashier_session_id) WHERE cashier_session_id IS NOT NULL;
CREATE INDEX payment_pending_idx ON payment (tenant_id, property_id) WHERE status = 'PENDING_VERIFICATION';

-- The ledger: append-only.
CREATE TABLE folio_posting (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL,
  folio_id            uuid NOT NULL,
  posting_type        text NOT NULL CHECK (posting_type IN ('CHARGE','TAX','DISCOUNT','PAYMENT','DEPOSIT_RECEIVED','REFUND','ADJUSTMENT','REVERSAL')),
  txn_code            text NOT NULL,
  description         text,
  amount_minor        bigint NOT NULL,
  currency            char(3) NOT NULL,
  quantity            numeric(12,3) NOT NULL DEFAULT 1,
  unit_price_minor    bigint,
  business_date       date NOT NULL,
  posted_at           timestamptz NOT NULL DEFAULT now(),
  source_type         text NOT NULL,                     -- ROOM_NIGHT | MANUAL | PAYMENT | PENALTY | ...
  source_ref          text,
  parent_posting_id   uuid,
  reverses_posting_id uuid,
  payment_id          uuid,
  cashier_session_id  uuid,
  reservation_room_id uuid,
  reason_code         text,
  note                text,
  idempotency_key     text,
  created_by          uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, parent_posting_id) REFERENCES folio_posting (tenant_id, id),
  FOREIGN KEY (tenant_id, reverses_posting_id) REFERENCES folio_posting (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_id) REFERENCES payment (tenant_id, id),
  CHECK (CASE posting_type WHEN 'CHARGE' THEN amount_minor > 0 WHEN 'TAX' THEN amount_minor >= 0 WHEN 'REFUND' THEN amount_minor > 0
         WHEN 'DISCOUNT' THEN amount_minor < 0 WHEN 'PAYMENT' THEN amount_minor < 0 WHEN 'DEPOSIT_RECEIVED' THEN amount_minor < 0 ELSE amount_minor <> 0 END),
  CHECK ((posting_type = 'REVERSAL') = (reverses_posting_id IS NOT NULL))
);
CREATE INDEX folio_posting_folio_idx ON folio_posting (tenant_id, folio_id, posted_at, id);
CREATE INDEX folio_posting_date_idx ON folio_posting (tenant_id, property_id, business_date);
CREATE INDEX folio_posting_payment_idx ON folio_posting (tenant_id, payment_id) WHERE payment_id IS NOT NULL;
CREATE UNIQUE INDEX folio_posting_idem ON folio_posting (tenant_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX folio_posting_one_reversal ON folio_posting (tenant_id, reverses_posting_id) WHERE reverses_posting_id IS NOT NULL;
-- one room charge per stay night per code: this is what makes the nightly posting idempotent at the database level
CREATE UNIQUE INDEX folio_posting_source_once ON folio_posting (tenant_id, source_type, source_ref, txn_code) WHERE source_ref IS NOT NULL AND posting_type IN ('CHARGE','DISCOUNT');

CREATE TRIGGER folio_posting_append_only BEFORE UPDATE OR DELETE ON folio_posting FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER folio_posting_no_truncate BEFORE TRUNCATE ON folio_posting FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- Every posting: folio must be open, the business date must not be closed, and the cached folio balance moves with it (same statement, same lock).
CREATE FUNCTION folio_posting_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE f_status text; p_date date;
BEGIN
  SELECT status INTO f_status FROM folio WHERE tenant_id = NEW.tenant_id AND id = NEW.folio_id FOR UPDATE;
  IF f_status IS DISTINCT FROM 'OPEN' THEN
    RAISE EXCEPTION 'folio is not open' USING ERRCODE = 'P0001', HINT = 'FOLIO_NOT_OPEN';
  END IF;
  SELECT business_date INTO p_date FROM property WHERE tenant_id = NEW.tenant_id AND id = NEW.property_id;
  IF NEW.business_date < p_date THEN
    RAISE EXCEPTION 'business date % is closed (current %)', NEW.business_date, p_date USING ERRCODE = 'P0001', HINT = 'BUSINESS_DATE_CLOSED';
  END IF;
  UPDATE folio SET balance_minor = balance_minor + NEW.amount_minor WHERE tenant_id = NEW.tenant_id AND id = NEW.folio_id;
  RETURN NEW;
END $$;
CREATE TRIGGER folio_posting_before_insert BEFORE INSERT ON folio_posting FOR EACH ROW EXECUTE FUNCTION folio_posting_guard();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['cashier_session','cash_drop','folio','payment','folio_posting'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON cashier_session, folio, payment TO hos_app;
GRANT SELECT, INSERT ON cash_drop, folio_posting TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('payment.verify',               'Verify (approve or reject) bank-transfer receipts and non-cash refunds entered by someone else'),
 ('cashier.review',               'Review closed cashier sessions and cash variances; see all sessions'),
 ('folio.checkout_with_balance',  'Let a guest check out with an unpaid or overpaid folio (creates a receivable / refund case)')
ON CONFLICT (key) DO NOTHING;
