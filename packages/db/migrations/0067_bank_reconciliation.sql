-- 0067 Finance step 5: bank statements, matching against the ledger, sign-off with a lock, and the queue of money that arrived without a known source.
CREATE TABLE bank_statement_batch (
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  payment_account_id uuid NOT NULL,
  filename           text CHECK (filename IS NULL OR length(filename) <= 200),
  lines_total        integer NOT NULL,
  lines_new          integer NOT NULL,
  imported_by        uuid NOT NULL,
  imported_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, payment_account_id) REFERENCES payment_account (tenant_id, id)
);
CREATE TABLE bank_statement_line (
  tenant_id          uuid NOT NULL REFERENCES tenant(id),
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  batch_id           uuid NOT NULL,
  payment_account_id uuid NOT NULL,
  value_date         date NOT NULL,
  narration          text NOT NULL DEFAULT '' CHECK (length(narration) <= 400),
  reference          text CHECK (reference IS NULL OR length(reference) <= 120),
  debit_minor        bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),     -- money out of the account
  credit_minor       bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),    -- money into the account
  balance_minor      bigint,
  line_hash          text NOT NULL,
  status             text NOT NULL DEFAULT 'UNMATCHED' CHECK (status IN ('UNMATCHED','MATCHED','IGNORED')),
  note               text CHECK (note IS NULL OR length(note) <= 300),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, payment_account_id, line_hash),
  FOREIGN KEY (tenant_id, batch_id) REFERENCES bank_statement_batch (tenant_id, id),
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);
CREATE INDEX bank_line_idx ON bank_statement_line (tenant_id, payment_account_id, value_date);
CREATE TABLE bank_match (
  tenant_id         uuid NOT NULL REFERENCES tenant(id),
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  statement_line_id uuid NOT NULL,
  gl_entry_id       uuid NOT NULL,
  amount_minor      bigint NOT NULL CHECK (amount_minor > 0),
  match_type        text NOT NULL CHECK (match_type IN ('AUTO','MANUAL','BOOKED')),
  reason            text CHECK (reason IS NULL OR length(reason) <= 300),
  matched_by        uuid,
  matched_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, gl_entry_id),                          -- a ledger entry is matched to one statement line only
  FOREIGN KEY (tenant_id, statement_line_id) REFERENCES bank_statement_line (tenant_id, id),
  FOREIGN KEY (tenant_id, gl_entry_id) REFERENCES gl_entry (tenant_id, id)
);
CREATE TABLE bank_reconciliation (
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  payment_account_id   uuid NOT NULL,
  period_to            date NOT NULL,
  statement_minor      bigint NOT NULL,
  ledger_minor         bigint NOT NULL,
  difference_minor     bigint NOT NULL,
  status               text NOT NULL CHECK (status IN ('PENDING','APPROVED')),
  note                 text CHECK (note IS NULL OR length(note) <= 300),
  prepared_by          uuid NOT NULL,
  prepared_at          timestamptz NOT NULL DEFAULT now(),
  approved_by          uuid,
  approved_at          timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, payment_account_id, period_to),
  FOREIGN KEY (tenant_id, payment_account_id) REFERENCES payment_account (tenant_id, id)
);
CREATE TABLE bank_suspense_item (
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  statement_line_id    uuid NOT NULL,
  voucher_id           uuid NOT NULL,
  amount_minor         bigint NOT NULL CHECK (amount_minor > 0),
  status               text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ALLOCATING','ALLOCATED')),
  assigned_to          uuid,
  note                 text CHECK (note IS NULL OR length(note) <= 500),
  allocated_voucher_id uuid,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, statement_line_id),
  FOREIGN KEY (tenant_id, statement_line_id) REFERENCES bank_statement_line (tenant_id, id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['bank_statement_batch','bank_statement_line','bank_match','bank_reconciliation','bank_suspense_item'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
GRANT DELETE ON bank_match TO hos_app;
