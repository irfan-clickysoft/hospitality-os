-- The note one shift leaves for the next: what happened, what is still open, and who read it.
CREATE TABLE shift_handover (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  business_date    date NOT NULL,
  shift            text NOT NULL CHECK (shift IN ('MORNING','EVENING','NIGHT')),
  author_id        uuid NOT NULL,
  notes            text NOT NULL CHECK (length(notes) BETWEEN 3 AND 2000),
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,           -- [{ text, done, doneBy, doneAt }]
  acknowledged_by  uuid,
  acknowledged_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX shift_handover_prop_idx ON shift_handover (tenant_id, property_id, created_at DESC);
ALTER TABLE shift_handover ENABLE ROW LEVEL SECURITY; ALTER TABLE shift_handover FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON shift_handover USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON shift_handover TO hos_admin; GRANT SELECT, INSERT, UPDATE ON shift_handover TO hos_app;
