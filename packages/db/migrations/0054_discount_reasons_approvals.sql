-- 0054 Discounts: why each was given and who gave and approved it, and a request-and-approve step for a discount bigger than the person at the desk may give.
INSERT INTO permission (key, description) VALUES ('reservation.approve_discount', 'Approve or reject a discount that is above what the person at the desk may give') ON CONFLICT (key) DO NOTHING;

ALTER TABLE reservation_room
  ADD COLUMN discount_code text CHECK (discount_code IS NULL OR length(discount_code) <= 40),
  ADD COLUMN discount_note text CHECK (discount_note IS NULL OR length(discount_note) <= 300),
  ADD COLUMN discount_given_by uuid,
  ADD COLUMN discount_approved_by uuid,
  ADD COLUMN discount_approved_at timestamptz,
  ADD COLUMN discount_approval_id uuid;

CREATE TABLE discount_approval (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  requested_by  uuid NOT NULL,
  request       jsonb NOT NULL,                                               -- exactly what was priced: dates, guests, room type, plan, discount; an approval only fits the same request
  code          text NOT NULL CHECK (length(code) <= 40),
  note          text CHECK (note IS NULL OR length(note) <= 300),
  pct           numeric NOT NULL CHECK (pct >= 0 AND pct <= 100),
  amount_minor  bigint NOT NULL CHECK (amount_minor >= 0),
  rooms         integer NOT NULL DEFAULT 1 CHECK (rooms BETWEEN 1 AND 10),
  used_rooms    integer NOT NULL DEFAULT 0 CHECK (used_rooms >= 0),
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','CANCELLED')),
  decided_by    uuid,
  decided_at    timestamptz,
  decision_note text CHECK (decision_note IS NULL OR length(decision_note) <= 300),
  expires_at    timestamptz NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (used_rooms <= rooms)
);
CREATE INDEX discount_approval_prop_idx ON discount_approval (tenant_id, property_id, status, created_at DESC);
ALTER TABLE discount_approval ENABLE ROW LEVEL SECURITY; ALTER TABLE discount_approval FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON discount_approval USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON discount_approval TO hos_admin; GRANT SELECT, INSERT, UPDATE ON discount_approval TO hos_app;
