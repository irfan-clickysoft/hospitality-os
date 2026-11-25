-- 0063 Accounting core (finance step 1): chart of accounts, vouchers with maker-checker approval, an immutable ledger, financial-period locks.
-- One company ledger (the tenant); the branch (property) is a dimension on every line. Money is bigint minor units; posted records are never changed, only reversed.
INSERT INTO permission (key, description) VALUES
 ('finance.view',    'See the chart of accounts, vouchers, ledger and finance reports'),
 ('finance.prepare', 'Prepare, edit, submit and reverse vouchers'),
 ('finance.approve', 'Approve and post, or reject, a voucher prepared by someone else'),
 ('finance.setup',   'Set up the chart of accounts and finance settings'),
 ('finance.period',  'Close and reopen financial periods')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE gl_settings (
  tenant_id               uuid PRIMARY KEY REFERENCES tenant(id),
  base_currency           char(3) NOT NULL DEFAULT 'PKR',
  self_approve_limit_minor bigint NOT NULL DEFAULT 0 CHECK (self_approve_limit_minor >= 0),   -- the preparer may approve their own voucher up to this amount; 0 = never
  updated_by              uuid,
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE gl_account (
  tenant_id      uuid NOT NULL REFERENCES tenant(id),
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  code           text NOT NULL CHECK (code ~ '^[0-9]{4,8}$'),
  name           text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  parent_id      uuid,
  account_type   text NOT NULL CHECK (account_type IN ('ASSET','LIABILITY','EQUITY','REVENUE','EXPENSE')),
  normal_balance text NOT NULL CHECK (normal_balance IN ('DEBIT','CREDIT')),
  is_group       boolean NOT NULL DEFAULT false,                 -- a heading: nothing is posted to it
  control_type   text CHECK (control_type IS NULL OR control_type IN ('CASH','PETTY_CASH','BANK','RECEIVABLE','PAYABLE','INTERBRANCH','SUSPENSE','TAX','GUEST_ADVANCE','GUEST_DEPOSIT')),
  active         boolean NOT NULL DEFAULT true,
  note           text CHECK (note IS NULL OR length(note) <= 300),
  created_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, parent_id) REFERENCES gl_account (tenant_id, id)
);

CREATE TABLE gl_period (                       -- a month; no row means open
  tenant_id  uuid NOT NULL REFERENCES tenant(id),
  month      date NOT NULL CHECK (month = date_trunc('month', month)::date),
  status     text NOT NULL CHECK (status IN ('OPEN','CLOSED')),
  changed_by uuid,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason     text,
  PRIMARY KEY (tenant_id, month)
);

CREATE TABLE voucher_counter (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  voucher_type text NOT NULL,
  year         integer NOT NULL,
  last_no      integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, voucher_type, year)
);

CREATE TABLE voucher (
  tenant_id            uuid NOT NULL REFERENCES tenant(id),
  id                   uuid NOT NULL DEFAULT gen_random_uuid(),
  voucher_no           text,                                     -- given when submitted
  voucher_type         text NOT NULL CHECK (voucher_type IN ('CRV','BRV','CPV','BPV','CTV','JV','IBEV','IBTV')),
  voucher_date         date NOT NULL,
  posting_date         date NOT NULL,
  status               text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SUBMITTED','POSTED','REJECTED','CANCELLED')),
  narration            text NOT NULL CHECK (length(btrim(narration)) BETWEEN 3 AND 500),
  currency             char(3) NOT NULL DEFAULT 'PKR',
  total_minor          bigint NOT NULL DEFAULT 0 CHECK (total_minor >= 0),
  source_module        text,
  source_event_id      text,                                     -- one voucher per source event: a repeat is refused
  reverses_voucher_id  uuid,
  created_by           uuid NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  submitted_by         uuid,
  submitted_at         timestamptz,
  approved_by          uuid,
  approved_at          timestamptz,
  posted_by            uuid,
  posted_at            timestamptz,
  rejected_by          uuid,
  reject_reason        text,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, voucher_no),
  FOREIGN KEY (tenant_id, reverses_voucher_id) REFERENCES voucher (tenant_id, id),
  CHECK ((source_module IS NULL) = (source_event_id IS NULL))
);
CREATE UNIQUE INDEX voucher_source_event_uq ON voucher (tenant_id, source_module, source_event_id) WHERE source_event_id IS NOT NULL;
CREATE UNIQUE INDEX voucher_one_reversal_uq ON voucher (tenant_id, reverses_voucher_id) WHERE reverses_voucher_id IS NOT NULL AND status IN ('DRAFT','SUBMITTED','POSTED');
CREATE INDEX voucher_status_idx ON voucher (tenant_id, status, posting_date);

CREATE TABLE voucher_line (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  voucher_id   uuid NOT NULL,
  line_no      integer NOT NULL,
  account_id   uuid NOT NULL,
  property_id  uuid,                                             -- the branch; null = head office
  debit_minor  bigint NOT NULL DEFAULT 0 CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL DEFAULT 0 CHECK (credit_minor >= 0),
  description  text CHECK (description IS NULL OR length(description) <= 300),
  reference    text CHECK (reference IS NULL OR length(reference) <= 120),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, voucher_id, line_no),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES gl_account (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK ((debit_minor > 0 AND credit_minor = 0) OR (credit_minor > 0 AND debit_minor = 0))
);

-- The ledger: one row per posted line. Never updated or deleted.
CREATE TABLE gl_entry (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  voucher_id   uuid NOT NULL,
  line_id      uuid NOT NULL,
  account_id   uuid NOT NULL,
  property_id  uuid,
  posting_date date NOT NULL,
  debit_minor  bigint NOT NULL CHECK (debit_minor >= 0),
  credit_minor bigint NOT NULL CHECK (credit_minor >= 0),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, line_id),
  FOREIGN KEY (tenant_id, voucher_id) REFERENCES voucher (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES gl_account (tenant_id, id)
);
CREATE INDEX gl_entry_account_idx ON gl_entry (tenant_id, account_id, posting_date);
CREATE INDEX gl_entry_date_idx ON gl_entry (tenant_id, posting_date);
CREATE TRIGGER gl_entry_no_update BEFORE UPDATE OR DELETE ON gl_entry FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER gl_entry_no_truncate BEFORE TRUNCATE ON gl_entry FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

-- A posted voucher is final; a voucher is balanced before it can be submitted or posted.
CREATE FUNCTION voucher_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d bigint; c bigint;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status <> 'DRAFT' THEN RAISE EXCEPTION 'Only a draft voucher can be deleted' USING ERRCODE = 'P0001'; END IF;
    RETURN OLD;
  END IF;
  IF OLD.status = 'POSTED' THEN RAISE EXCEPTION 'A posted voucher cannot be changed; reverse it instead' USING ERRCODE = 'P0001'; END IF;
  IF NEW.status IN ('SUBMITTED','POSTED') THEN
    SELECT coalesce(sum(debit_minor),0), coalesce(sum(credit_minor),0) INTO d, c FROM voucher_line WHERE tenant_id = NEW.tenant_id AND voucher_id = NEW.id;
    IF d <> c OR d = 0 THEN RAISE EXCEPTION 'Voucher is not balanced: debits % and credits %', d, c USING ERRCODE = 'P0001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voucher_guard_trg BEFORE UPDATE OR DELETE ON voucher FOR EACH ROW EXECUTE FUNCTION voucher_guard();

CREATE FUNCTION voucher_line_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s text; vid uuid; tid uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN vid := OLD.voucher_id; tid := OLD.tenant_id; ELSE vid := NEW.voucher_id; tid := NEW.tenant_id; END IF;
  SELECT status INTO s FROM voucher WHERE tenant_id = tid AND id = vid;
  IF s IS NOT NULL AND s NOT IN ('DRAFT','REJECTED') THEN RAISE EXCEPTION 'The lines of a % voucher cannot be changed', s USING ERRCODE = 'P0001'; END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $$;
CREATE TRIGGER voucher_line_guard_trg BEFORE INSERT OR UPDATE OR DELETE ON voucher_line FOR EACH ROW EXECUTE FUNCTION voucher_line_guard();

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['gl_settings','gl_account','gl_period','voucher_counter','voucher','voucher_line','gl_entry'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON gl_settings, gl_account, gl_period, voucher_counter, voucher TO hos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON voucher_line TO hos_app;
GRANT SELECT, INSERT, DELETE ON voucher TO hos_app;
GRANT SELECT, INSERT ON gl_entry TO hos_app;
