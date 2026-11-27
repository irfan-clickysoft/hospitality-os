-- 0072 Finance step 11: recurring expenses (rent, internet, software...). A template prepares a supplier bill for each period; the bill is a draft that someone reviews and a second person approves.
CREATE TABLE recurring_expense (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  code         text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{1,23}$'),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  supplier_id  uuid NOT NULL,
  property_id  uuid NOT NULL,
  frequency    text NOT NULL CHECK (frequency IN ('MONTHLY','QUARTERLY','YEARLY')),
  day_of_month smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  start_month  date NOT NULL CHECK (start_month = date_trunc('month', start_month)::date),
  end_month    date CHECK (end_month IS NULL OR (end_month = date_trunc('month', end_month)::date AND end_month >= start_month)),
  narration    text NOT NULL CHECK (length(btrim(narration)) BETWEEN 3 AND 300),
  lines        jsonb NOT NULL,                              -- [{account, amount, description?}]
  active       boolean NOT NULL DEFAULT true,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code),
  FOREIGN KEY (tenant_id, supplier_id) REFERENCES supplier (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE TABLE recurring_expense_run (
  tenant_id    uuid NOT NULL REFERENCES tenant(id),
  recurring_id uuid NOT NULL,
  month        date NOT NULL,
  bill_id      uuid NOT NULL,
  prepared_by  uuid NOT NULL,
  prepared_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, recurring_id, month),            -- one bill per template per period
  FOREIGN KEY (tenant_id, recurring_id) REFERENCES recurring_expense (tenant_id, id),
  FOREIGN KEY (tenant_id, bill_id) REFERENCES supplier_bill (tenant_id, id)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['recurring_expense','recurring_expense_run'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO hos_app', t);
  END LOOP;
END $$;
