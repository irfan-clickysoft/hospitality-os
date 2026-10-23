-- 0043 Hotel Eye is filled in by hand on the police portal. The system keeps track of who has been entered (and under which portal reference), so no guest is missed and none is entered twice.
ALTER TABLE stay_guest ADD COLUMN he_entered_at timestamptz, ADD COLUMN he_entered_by uuid, ADD COLUMN he_ref text CHECK (he_ref IS NULL OR length(he_ref) <= 60);
CREATE INDEX stay_guest_he_pending_idx ON stay_guest (tenant_id, property_id, reservation_room_id) WHERE voided_at IS NULL AND he_entered_at IS NULL;
