-- 0030 Maintenance as a request-and-approve workflow: anyone with the right can ask for corrective or preventive work, a manager / admin / owner approves it, and it goes to
-- an in-house technician or a third-party contractor (with its contract and SLA), with an estimate before and the actual cost after.

CREATE TABLE maintenance_vendor (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  trade              text NOT NULL DEFAULT 'GENERAL' CHECK (trade IN ('GENERAL','PLUMBING','ELECTRICAL','AC','FURNITURE','APPLIANCE','CLEANLINESS','SAFETY','FUMIGATION','OTHER')),
  contact_name       text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  phone              text CHECK (phone IS NULL OR length(phone) <= 30),
  email              text CHECK (email IS NULL OR length(email) <= 200),
  contract_ref       text CHECK (contract_ref IS NULL OR length(contract_ref) <= 80),
  contract_start     date,
  contract_end       date,
  sla_response_hours integer CHECK (sla_response_hours IS NULL OR sla_response_hours BETWEEN 1 AND 720),    -- from being given the job to starting it
  sla_fix_hours      integer CHECK (sla_fix_hours IS NULL OR sla_fix_hours BETWEEN 1 AND 2160),             -- from being given the job to finishing it
  notes              text CHECK (notes IS NULL OR length(notes) <= 1000),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name),
  CHECK (contract_end IS NULL OR contract_start IS NULL OR contract_end >= contract_start)
);
ALTER TABLE maintenance_vendor ENABLE ROW LEVEL SECURITY;
ALTER TABLE maintenance_vendor FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON maintenance_vendor USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON maintenance_vendor TO hos_admin;
GRANT SELECT, INSERT, UPDATE ON maintenance_vendor TO hos_app;

ALTER TABLE work_order DROP CONSTRAINT work_order_status_check;
ALTER TABLE work_order
  ADD CONSTRAINT work_order_status_check CHECK (status IN ('REQUESTED','REJECTED','OPEN','ASSIGNED','IN_PROGRESS','WAITING','DONE','VERIFIED','CANCELLED')),
  ADD COLUMN kind text NOT NULL DEFAULT 'CORRECTIVE' CHECK (kind IN ('CORRECTIVE','PREVENTIVE')),
  ADD COLUMN estimated_cost_minor bigint CHECK (estimated_cost_minor IS NULL OR estimated_cost_minor >= 0),
  ADD COLUMN vendor_id uuid,
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN approved_by uuid,
  ADD COLUMN approved_at timestamptz,
  ADD COLUMN rejected_reason text,
  ADD CONSTRAINT work_order_vendor_fk FOREIGN KEY (tenant_id, vendor_id) REFERENCES maintenance_vendor (tenant_id, id),
  ADD CONSTRAINT work_order_one_assignee CHECK (assigned_to IS NULL OR vendor_id IS NULL);
ALTER TABLE work_order DROP CONSTRAINT work_order_category_check;
ALTER TABLE work_order ADD CONSTRAINT work_order_category_check CHECK (category IN ('PLUMBING','ELECTRICAL','AC','FURNITURE','APPLIANCE','CLEANLINESS','SAFETY','FUMIGATION','OTHER'));
CREATE INDEX work_order_vendor_idx ON work_order (tenant_id, vendor_id) WHERE vendor_id IS NOT NULL;

ALTER TABLE message_template DROP CONSTRAINT message_template_event_check;
ALTER TABLE message_template ADD CONSTRAINT message_template_event_check CHECK (event IN ('RESERVATION_CONFIRMED','CHECK_IN','PAYMENT_RECEIVED','SERVICE_ORDER','CHECK_OUT','REFUND','DOCUMENT','MAINTENANCE_ASSIGNED'));

INSERT INTO permission (key, description) VALUES
 ('maintenance.request', 'Ask for corrective or preventive maintenance (it then waits for approval)'),
 ('maintenance.approve', 'Approve or reject maintenance requests'),
 ('maintenance.vendor',  'Add and change third-party contractors and their contracts')
ON CONFLICT (key) DO NOTHING;

-- A phone number for staff, so a technician can be messaged about an urgent job.
ALTER TABLE staff_user ADD COLUMN phone text CHECK (phone IS NULL OR length(phone) <= 30);
