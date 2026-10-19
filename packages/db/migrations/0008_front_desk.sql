-- 0008 Front desk: housekeeping status on rooms, check-in / check-out facts, registered occupants with identity documents.

ALTER TABLE room
  ADD COLUMN hk_status     text NOT NULL DEFAULT 'CLEAN' CHECK (hk_status IN ('CLEAN','DIRTY','INSPECTED')),
  ADD COLUMN hk_updated_at timestamptz;

ALTER TABLE reservation_room
  ADD COLUMN checked_in_at              timestamptz,
  ADD COLUMN checked_in_business_date   date,
  ADD COLUMN checked_out_at             timestamptz,
  ADD COLUMN checked_out_business_date  date,
  ADD COLUMN original_departure         date;          -- set when a stay is cut short at check-out

-- Registration card: everyone staying in a room, with identity documents. Document numbers are encrypted at rest (AES-256-GCM, bound to tenant + room line).
CREATE TABLE stay_guest (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id         uuid NOT NULL,
  reservation_room_id uuid NOT NULL,
  full_name           text NOT NULL CHECK (length(btrim(full_name)) BETWEEN 2 AND 160),
  is_primary          boolean NOT NULL DEFAULT false,
  age_group           text NOT NULL DEFAULT 'ADULT' CHECK (age_group IN ('ADULT','CHILD')),
  id_type             text NOT NULL CHECK (id_type IN ('CNIC','NICOP','PASSPORT','DRIVING_LICENSE','OTHER')),
  id_number_sealed    text NOT NULL,
  id_last4            text NOT NULL,
  nationality         char(2),
  id_expiry           date,
  voided_at           timestamptz,                       -- check-in undone: the record is kept, not deleted
  created_by          uuid,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, reservation_room_id) REFERENCES reservation_room (tenant_id, id)
);
CREATE UNIQUE INDEX stay_guest_one_primary ON stay_guest (tenant_id, reservation_room_id) WHERE is_primary AND voided_at IS NULL;
CREATE INDEX stay_guest_line_idx ON stay_guest (tenant_id, reservation_room_id);

ALTER TABLE stay_guest ENABLE ROW LEVEL SECURITY;
ALTER TABLE stay_guest FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON stay_guest USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON stay_guest TO hos_admin;
GRANT SELECT, INSERT, UPDATE ON stay_guest TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('frontdesk.check_in',     'Check guests in and register their identity documents'),
 ('frontdesk.check_out',    'Check guests out'),
 ('frontdesk.override_room','Check a guest into a room that is not marked clean, or reopen a checked-out stay'),
 ('frontdesk.view_id',      'See full identity document numbers on registration cards')
ON CONFLICT (key) DO NOTHING;
