-- 0053 Cancellations and no-shows: a standard reason and who initiated it, kept on each room line, so the cancellation report can say why business was lost.
ALTER TABLE reservation_room
  ADD COLUMN cancel_code text CHECK (cancel_code IS NULL OR length(cancel_code) <= 40),
  ADD COLUMN cancel_initiator text CHECK (cancel_initiator IS NULL OR cancel_initiator IN ('GUEST','PROPERTY','CHANNEL','COMPANY','SYSTEM'));
CREATE INDEX reservation_room_cancel_idx ON reservation_room (tenant_id, property_id, cancel_code) WHERE cancel_code IS NOT NULL;
