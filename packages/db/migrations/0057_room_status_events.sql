-- Every change of a room's housekeeping state (dirty, cleaning, clean, inspected), so the history can be reported and cleaning times worked out.
CREATE TABLE room_status_event (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  room_id      uuid NOT NULL,
  from_status  text,
  to_status    text NOT NULL,
  reason       text,
  actor_id     uuid,                       -- NULL when the system changed it (for example at check-out or night audit)
  occurred_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX room_status_event_prop_idx ON room_status_event (tenant_id, property_id, occurred_at DESC);
CREATE INDEX room_status_event_room_idx ON room_status_event (tenant_id, room_id, occurred_at);
ALTER TABLE room_status_event ENABLE ROW LEVEL SECURITY; ALTER TABLE room_status_event FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_status_event USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON room_status_event TO hos_admin; GRANT SELECT, INSERT ON room_status_event TO hos_app;
