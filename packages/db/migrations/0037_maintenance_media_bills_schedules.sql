-- 0037 Maintenance, continued: pictures and videos on a job, bills from the contractor (or a parts shop) that have to be approved and then paid, and recurring preventive jobs that
-- create their own work orders as they fall due.

INSERT INTO permission (key, description) VALUES
 ('maintenance.pay', 'Mark an approved maintenance bill as paid to the contractor')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE work_order_media (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('IMAGE','VIDEO')),
  stage         text NOT NULL CHECK (stage IN ('REPORTED','PROGRESS','COMPLETED')),     -- the problem as reported, the work under way, the finished job
  file_name     text NOT NULL UNIQUE CHECK (file_name ~ '^[0-9a-f]{32}\.(jpg|png|webp|mp4|webm)$'),
  content_type  text NOT NULL,
  size_bytes    bigint NOT NULL CHECK (size_bytes > 0),
  caption       text CHECK (caption IS NULL OR length(caption) <= 160),
  uploaded_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_order (tenant_id, id)
);
CREATE INDEX work_order_media_idx ON work_order_media (tenant_id, work_order_id, created_at);

CREATE TABLE work_order_bill (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  work_order_id uuid NOT NULL,
  vendor_id     uuid,
  payee         text CHECK (payee IS NULL OR length(btrim(payee)) BETWEEN 2 AND 120),    -- for a shop or person who is not a listed contractor
  bill_no       text NOT NULL CHECK (length(btrim(bill_no)) BETWEEN 1 AND 60),
  bill_date     date NOT NULL,
  due_date      date,
  amount_minor  bigint NOT NULL CHECK (amount_minor > 0),
  note          text CHECK (note IS NULL OR length(note) <= 300),
  file_name     text,                                                                    -- the scanned or photographed bill, kept private
  content_type  text,
  status        text NOT NULL DEFAULT 'RECEIVED' CHECK (status IN ('RECEIVED','APPROVED','REJECTED','PAID')),
  decided_by    uuid,
  decided_at    timestamptz,
  reject_reason text,
  paid_by       uuid,
  paid_at       timestamptz,
  paid_method   text CHECK (paid_method IS NULL OR paid_method IN ('CASH','BANK_TRANSFER','CHEQUE','OTHER')),
  paid_ref      text CHECK (paid_ref IS NULL OR length(paid_ref) <= 80),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_order (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES maintenance_vendor (tenant_id, id),
  CHECK (vendor_id IS NOT NULL OR payee IS NOT NULL)
);
-- the same contractor's bill number is entered once (a rejected one may be entered again corrected)
CREATE UNIQUE INDEX work_order_bill_no_uq ON work_order_bill (tenant_id, vendor_id, lower(btrim(bill_no))) WHERE vendor_id IS NOT NULL AND status <> 'REJECTED';
CREATE INDEX work_order_bill_open_idx ON work_order_bill (tenant_id, property_id, status);

CREATE TABLE maintenance_schedule (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  description   text CHECK (description IS NULL OR length(description) <= 2000),
  category      text NOT NULL CHECK (category IN ('PLUMBING','ELECTRICAL','AC','FURNITURE','APPLIANCE','CLEANLINESS','SAFETY','FUMIGATION','OTHER')),
  priority      integer NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),
  room_id       uuid,
  area          text CHECK (area IS NULL OR length(area) <= 80),
  every_n       integer NOT NULL CHECK (every_n BETWEEN 1 AND 365),
  unit          text NOT NULL CHECK (unit IN ('DAY','WEEK','MONTH','YEAR')),
  next_due      date NOT NULL,
  lead_days     integer NOT NULL DEFAULT 7 CHECK (lead_days BETWEEN 0 AND 60),            -- the job is created this many days before it is due
  assigned_to   uuid,
  vendor_id     uuid,
  estimated_cost_minor bigint CHECK (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0),
  active        boolean NOT NULL DEFAULT true,
  last_created_for date,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, vendor_id) REFERENCES maintenance_vendor (tenant_id, id),
  CHECK (assigned_to IS NULL OR vendor_id IS NULL)
);
ALTER TABLE work_order ADD COLUMN schedule_id uuid, ADD CONSTRAINT work_order_schedule_fk FOREIGN KEY (tenant_id, schedule_id) REFERENCES maintenance_schedule (tenant_id, id);
CREATE UNIQUE INDEX work_order_schedule_due_uq ON work_order (tenant_id, schedule_id, due_date) WHERE schedule_id IS NOT NULL;        -- a due date makes one job, however often generation runs

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_order_media','work_order_bill','maintenance_schedule'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, DELETE ON work_order_media TO hos_app;
GRANT SELECT, INSERT, UPDATE ON work_order_bill, maintenance_schedule TO hos_app;
