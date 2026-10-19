-- 0020 Kitchen and room-service orders: a menu per property, orders for in-house guests, a kitchen queue, and a charge on the guest's bill when the food is delivered.

CREATE TABLE menu_item (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  category     text NOT NULL CHECK (length(btrim(category)) BETWEEN 2 AND 60),
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  name_ur      text,
  price_minor  bigint NOT NULL CHECK (price_minor >= 0),
  active       boolean NOT NULL DEFAULT true,
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  version      integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE UNIQUE INDEX menu_item_name_uq ON menu_item (tenant_id, property_id, lower(btrim(name))) WHERE active;

CREATE TABLE fnb_order (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  number          text NOT NULL,
  reservation_id  uuid NOT NULL,
  reservation_room_id uuid NOT NULL,
  folio_id        uuid NOT NULL,
  room_number     text NOT NULL,
  guest_name      text NOT NULL,
  status          text NOT NULL DEFAULT 'NEW' CHECK (status IN ('NEW','PREPARING','READY','DELIVERED','CANCELLED')),
  note            text,
  total_minor     bigint NOT NULL CHECK (total_minor >= 0),
  currency        char(3) NOT NULL,
  created_by      uuid NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  prepared_at     timestamptz,
  ready_at        timestamptz,
  delivered_at    timestamptz,
  delivered_by    uuid,
  business_date   date,                                    -- the day the charge was posted
  cancel_reason   text,
  cancelled_by    uuid,
  version         integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, number),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, property_id, folio_id) REFERENCES folio (tenant_id, property_id, id),
  CHECK ((status = 'DELIVERED') = (delivered_at IS NOT NULL)),
  CHECK ((status = 'CANCELLED') = (cancel_reason IS NOT NULL))
);
CREATE INDEX fnb_order_queue_idx ON fnb_order (tenant_id, property_id, status, created_at);

CREATE TABLE fnb_order_line (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  order_id         uuid NOT NULL,
  menu_item_id     uuid NOT NULL,
  name             text NOT NULL,                          -- as it was on the menu when ordered
  quantity         integer NOT NULL CHECK (quantity BETWEEN 1 AND 99),
  unit_price_minor bigint NOT NULL CHECK (unit_price_minor >= 0),
  line_minor       bigint NOT NULL CHECK (line_minor >= 0),
  note             text,
  posting_id       uuid,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES fnb_order (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_item (tenant_id, id),
  FOREIGN KEY (tenant_id, posting_id) REFERENCES folio_posting (tenant_id, id),
  CHECK (line_minor = unit_price_minor * quantity)
);
CREATE INDEX fnb_order_line_idx ON fnb_order_line (tenant_id, order_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['menu_item','fnb_order','fnb_order_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON menu_item, fnb_order, fnb_order_line TO hos_app;
