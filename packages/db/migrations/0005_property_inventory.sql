-- 0005 Property structure, room types, rooms, amenities, blocks, inventory counters, physical-room assignment constraint.

CREATE TABLE building (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  name        text NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (tenant_id, property_id, name),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);

CREATE TABLE floor (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  building_id uuid,
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id, building_id) REFERENCES building (tenant_id, property_id, id)
);
CREATE UNIQUE INDEX floor_name_uq ON floor (tenant_id, property_id, COALESCE(building_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE room_type (
  tenant_id              uuid NOT NULL,
  id                     uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id            uuid NOT NULL,
  code                   text NOT NULL CHECK (code ~ '^[A-Za-z0-9_-]{1,20}$'),
  name                   text NOT NULL,
  description            text,
  max_adults             integer NOT NULL CHECK (max_adults BETWEEN 1 AND 20),
  max_children           integer NOT NULL DEFAULT 0 CHECK (max_children BETWEEN 0 AND 20),
  max_occupancy          integer NOT NULL CHECK (max_occupancy BETWEEN 1 AND 30),
  base_occupancy         integer NOT NULL DEFAULT 2 CHECK (base_occupancy >= 1),
  bed_config             text,
  size_sqm               numeric(7,2),
  default_overbook_limit integer NOT NULL DEFAULT 0 CHECK (default_overbook_limit >= 0),
  status                 text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ARCHIVED')),
  sort_order             integer NOT NULL DEFAULT 0,
  version                integer NOT NULL DEFAULT 1,
  created_at             timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  UNIQUE (tenant_id, property_id, code),
  CHECK (base_occupancy <= max_occupancy),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);

CREATE TABLE room (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id       uuid NOT NULL,
  room_type_id      uuid NOT NULL,
  floor_id          uuid,
  number            text NOT NULL CHECK (length(number) BETWEEN 1 AND 12),
  capacity_override integer CHECK (capacity_override BETWEEN 1 AND 30),
  bed_config        text,
  smoking           boolean NOT NULL DEFAULT false,
  accessible        boolean NOT NULL DEFAULT false,
  connecting_room_id uuid,
  status            text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),   -- INACTIVE = retired (not billed, not sold)
  notes             text,
  version           integer NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, floor_id)     REFERENCES floor (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, connecting_room_id) REFERENCES room (tenant_id, property_id, id),
  CHECK (connecting_room_id IS NULL OR connecting_room_id <> id)
);
CREATE UNIQUE INDEX room_number_uq ON room (tenant_id, property_id, lower(number));
CREATE INDEX room_type_idx ON room (tenant_id, property_id, room_type_id) WHERE status = 'ACTIVE';

-- Tenant-level configurable amenity catalogue.
CREATE TABLE amenity (
  tenant_id uuid NOT NULL REFERENCES tenant(id),
  id        uuid NOT NULL DEFAULT gen_random_uuid(),
  code      text NOT NULL CHECK (code ~ '^[a-z0-9_]{2,40}$'),
  name_en   text NOT NULL,
  name_ur   text,
  category  text NOT NULL DEFAULT 'GENERAL',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, code)
);
CREATE TABLE room_type_amenity (
  tenant_id    uuid NOT NULL,
  room_type_id uuid NOT NULL,
  amenity_id   uuid NOT NULL,
  PRIMARY KEY (tenant_id, room_type_id, amenity_id),
  FOREIGN KEY (tenant_id, room_type_id) REFERENCES room_type (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, amenity_id)   REFERENCES amenity (tenant_id, id) ON DELETE CASCADE
);

-- Out-of-order / out-of-service blocks. end_date is EXCLUSIVE (the first night the room is available again).
CREATE TABLE room_block (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  room_id      uuid NOT NULL,
  block_type   text NOT NULL CHECK (block_type IN ('OUT_OF_ORDER','OUT_OF_SERVICE')),
  start_date   date NOT NULL,
  end_date     date NOT NULL,
  reason       text NOT NULL,
  ticket_ref   text,
  created_by   uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  cancelled_at timestamptz,
  PRIMARY KEY (tenant_id, id),
  CHECK (end_date > start_date),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES room (tenant_id, property_id, id),
  EXCLUDE USING gist (room_id WITH =, daterange(start_date, end_date) WITH &&) WHERE (cancelled_at IS NULL)
);

-- Per room type per night counters. Mutated ONLY by InventoryService (single writer) with conditional atomic updates.
CREATE TABLE inventory_day (
  tenant_id        uuid NOT NULL,
  property_id      uuid NOT NULL,
  room_type_id     uuid NOT NULL,
  business_date    date NOT NULL,
  physical         integer NOT NULL CHECK (physical >= 0),          -- active rooms of the type
  out_of_order     integer NOT NULL DEFAULT 0 CHECK (out_of_order >= 0),
  out_of_service   integer NOT NULL DEFAULT 0 CHECK (out_of_service >= 0),
  blocked          integer NOT NULL DEFAULT 0 CHECK (blocked >= 0),  -- group / allotment blocks not yet picked up
  reserved         integer NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  held             integer NOT NULL DEFAULT 0 CHECK (held >= 0),     -- unexpired holds (booking-engine checkout, options)
  overbook_limit   integer NOT NULL DEFAULT 0 CHECK (overbook_limit >= 0),
  version          integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, property_id, room_type_id, business_date),
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id)
);
CREATE INDEX inventory_day_date_idx ON inventory_day (tenant_id, property_id, business_date);

-- Physical room assignment: a room can never be assigned to two overlapping stays, regardless of application logic.
CREATE TABLE room_assignment (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id    uuid NOT NULL,
  room_id        uuid NOT NULL,
  assignment_ref uuid NOT NULL,                 -- owning reservation room / stay (FK added with the reservations module)
  stay_range     daterange NOT NULL,            -- [arrival, departure) in property business dates
  status         text NOT NULL CHECK (status IN ('ASSIGNED','IN_HOUSE','ENDED')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CHECK (NOT isempty(stay_range)),
  FOREIGN KEY (tenant_id, property_id, room_id) REFERENCES room (tenant_id, property_id, id),
  EXCLUDE USING gist (room_id WITH =, stay_range WITH &&) WHERE (status IN ('ASSIGNED','IN_HOUSE'))
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['building','floor','room_type','room','amenity','room_type_amenity','room_block','inventory_day','room_assignment'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
-- Counters and blocks are never deleted (history); room_type_amenity may be removed.
REVOKE DELETE ON inventory_day, room_assignment, room_block FROM hos_app;
GRANT ALL ON building, floor, room_type, room, amenity, room_type_amenity, room_block, inventory_day, room_assignment TO hos_admin;

INSERT INTO permission (key, description) VALUES
 ('inventory.block',    'Create and cancel out-of-order / out-of-service room blocks'),
 ('inventory.overbook', 'Configure overbooking limits and approve blocks that would oversell')
ON CONFLICT (key) DO NOTHING;
