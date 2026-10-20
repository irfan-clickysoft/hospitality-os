-- 0034 Outlets and menus: a property has outlets (restaurant, room service, café, bar…), an outlet has menus, a menu has categories, a category has items. An item carries what a guest and the kitchen
-- need — description, price, portion, timing, pictures and a short video, availability, ingredients, allergens, dietary labels, nutrition — plus variants (half / full) and modifier groups
-- (choose a side, add extras) that change the price. The earlier flat menu keeps working: its items are gathered into a default outlet the first time the new menu is opened.

CREATE TABLE outlet (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  name         text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  kind         text NOT NULL DEFAULT 'RESTAURANT' CHECK (kind IN ('RESTAURANT','ROOM_SERVICE','CAFE','BAR','BANQUET','OTHER')),
  description  text CHECK (description IS NULL OR length(description) <= 500),
  opening_note text CHECK (opening_note IS NULL OR length(opening_note) <= 200),
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order   integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE UNIQUE INDEX outlet_name_uq ON outlet (tenant_id, property_id, lower(btrim(name)));

CREATE TABLE menu (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  outlet_id     uuid NOT NULL,
  name          text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  days          smallint[] NOT NULL DEFAULT '{1,2,3,4,5,6,7}',                 -- ISO weekdays it is served
  available_from time,
  available_to   time,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  sort_order    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet (tenant_id, id),
  CHECK ((available_from IS NULL) = (available_to IS NULL))
);
CREATE UNIQUE INDEX menu_name_uq ON menu (tenant_id, outlet_id, lower(btrim(name)));

CREATE TABLE menu_category (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  menu_id     uuid NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  name_ur     text,
  description text CHECK (description IS NULL OR length(description) <= 300),
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_id) REFERENCES menu (tenant_id, id)
);
CREATE UNIQUE INDEX menu_category_name_uq ON menu_category (tenant_id, menu_id, lower(btrim(name)));

ALTER TABLE menu_item
  ADD COLUMN category_id        uuid,
  ADD COLUMN short_description  text CHECK (short_description IS NULL OR length(short_description) <= 160),
  ADD COLUMN description        text CHECK (description IS NULL OR length(description) <= 2000),
  ADD COLUMN discounted_price_minor bigint CHECK (discounted_price_minor IS NULL OR (discounted_price_minor >= 0)),
  ADD COLUMN serving_size       text CHECK (serving_size IS NULL OR length(serving_size) <= 60),
  ADD COLUMN serves             integer CHECK (serves IS NULL OR serves BETWEEN 1 AND 50),
  ADD COLUMN portion_amount     text CHECK (portion_amount IS NULL OR length(portion_amount) <= 40),          -- weight or volume, e.g. 450 g, 330 ml
  ADD COLUMN prep_min_minutes   integer CHECK (prep_min_minutes IS NULL OR prep_min_minutes BETWEEN 0 AND 480),
  ADD COLUMN prep_max_minutes   integer CHECK (prep_max_minutes IS NULL OR prep_max_minutes BETWEEN 0 AND 480),
  ADD COLUMN availability       text NOT NULL DEFAULT 'AVAILABLE' CHECK (availability IN ('AVAILABLE','SOLD_OUT','LIMITED')),
  ADD COLUMN limited_quantity   integer CHECK (limited_quantity IS NULL OR limited_quantity >= 0),
  ADD COLUMN days               smallint[],                                    -- null: every day the menu is served
  ADD COLUMN available_from     time,
  ADD COLUMN available_to       time,
  ADD COLUMN ingredients        text[] NOT NULL DEFAULT '{}',
  ADD COLUMN removable_ingredients text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allergens_contain  text[] NOT NULL DEFAULT '{}',
  ADD COLUMN allergens_may      text[] NOT NULL DEFAULT '{}',
  ADD COLUMN dietary            text[] NOT NULL DEFAULT '{}',
  ADD COLUMN calories           integer CHECK (calories IS NULL OR calories >= 0),
  ADD COLUMN protein_g          numeric(6,1) CHECK (protein_g IS NULL OR protein_g >= 0),
  ADD COLUMN carbs_g            numeric(6,1) CHECK (carbs_g IS NULL OR carbs_g >= 0),
  ADD COLUMN fat_g              numeric(6,1) CHECK (fat_g IS NULL OR fat_g >= 0),
  ADD COLUMN sodium_mg          integer CHECK (sodium_mg IS NULL OR sodium_mg >= 0),
  ADD COLUMN spice_level        smallint CHECK (spice_level IS NULL OR spice_level BETWEEN 0 AND 4),
  ADD COLUMN cuisine            text CHECK (cuisine IS NULL OR length(cuisine) <= 60),
  ADD COLUMN temperature        text CHECK (temperature IS NULL OR temperature IN ('HOT','WARM','COLD','AMBIENT')),
  ADD COLUMN pairings           text CHECK (pairings IS NULL OR length(pairings) <= 200),
  ADD COLUMN min_quantity       integer NOT NULL DEFAULT 1 CHECK (min_quantity BETWEEN 1 AND 99),
  ADD COLUMN max_quantity       integer NOT NULL DEFAULT 20 CHECK (max_quantity BETWEEN 1 AND 99),
  ADD COLUMN special_instructions boolean NOT NULL DEFAULT true,
  ADD CONSTRAINT menu_item_category_fk FOREIGN KEY (tenant_id, category_id) REFERENCES menu_category (tenant_id, id),
  ADD CONSTRAINT menu_item_prep_range CHECK (prep_min_minutes IS NULL OR prep_max_minutes IS NULL OR prep_min_minutes <= prep_max_minutes),
  ADD CONSTRAINT menu_item_discount CHECK (discounted_price_minor IS NULL OR discounted_price_minor <= price_minor),
  ADD CONSTRAINT menu_item_qty_range CHECK (min_quantity <= max_quantity),
  ADD CONSTRAINT menu_item_limited CHECK ((availability = 'LIMITED') = (limited_quantity IS NOT NULL)),
  ADD CONSTRAINT menu_item_time_pair CHECK ((available_from IS NULL) = (available_to IS NULL));
CREATE INDEX menu_item_category_idx ON menu_item (tenant_id, category_id) WHERE category_id IS NOT NULL;

CREATE TABLE menu_item_variant (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id     uuid NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 60),
  price_minor bigint NOT NULL CHECK (price_minor >= 0),               -- the whole price of this size, not a difference
  serves      integer CHECK (serves IS NULL OR serves BETWEEN 1 AND 50),
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES menu_item (tenant_id, id)
);
CREATE UNIQUE INDEX menu_item_variant_uq ON menu_item_variant (tenant_id, item_id, lower(btrim(name))) WHERE active;

CREATE TABLE modifier_group (
  tenant_id   uuid NOT NULL,
  id          uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL,
  name        text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  min_select  integer NOT NULL DEFAULT 0 CHECK (min_select BETWEEN 0 AND 20),
  max_select  integer NOT NULL DEFAULT 1 CHECK (max_select BETWEEN 1 AND 20),
  active      boolean NOT NULL DEFAULT true,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  CHECK (min_select <= max_select)
);
CREATE UNIQUE INDEX modifier_group_name_uq ON modifier_group (tenant_id, property_id, lower(btrim(name))) WHERE active;

CREATE TABLE modifier_option (
  tenant_id         uuid NOT NULL,
  id                uuid NOT NULL DEFAULT gen_random_uuid(),
  group_id          uuid NOT NULL,
  name              text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  price_delta_minor bigint NOT NULL DEFAULT 0,
  active            boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES modifier_group (tenant_id, id)
);

CREATE TABLE menu_item_modifier_group (
  tenant_id  uuid NOT NULL,
  item_id    uuid NOT NULL,
  group_id   uuid NOT NULL,
  sort_order integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, item_id, group_id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES menu_item (tenant_id, id),
  FOREIGN KEY (tenant_id, group_id) REFERENCES modifier_group (tenant_id, id)
);

CREATE TABLE menu_item_media (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  item_id      uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('IMAGE','VIDEO')),
  file_name    text NOT NULL UNIQUE CHECK (file_name ~ '^[0-9a-f]{32}\.(jpg|png|webp|mp4|webm)$'),
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  alt_text     text CHECK (alt_text IS NULL OR length(alt_text) <= 160),
  is_primary   boolean NOT NULL DEFAULT false,
  sort_order   integer NOT NULL DEFAULT 0,
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES menu_item (tenant_id, id)
);
CREATE UNIQUE INDEX menu_item_media_primary_uq ON menu_item_media (tenant_id, item_id) WHERE is_primary;

-- what was ordered: the size, the extras and the removed ingredients as they were at the time
ALTER TABLE fnb_order_line
  ADD COLUMN variant_name text,
  ADD COLUMN modifiers    jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN removed      text[] NOT NULL DEFAULT '{}';
ALTER TABLE fnb_order ADD COLUMN outlet_id uuid, ADD CONSTRAINT fnb_order_outlet_fk FOREIGN KEY (tenant_id, outlet_id) REFERENCES outlet (tenant_id, id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['outlet','menu','menu_category','menu_item_variant','modifier_group','modifier_option','menu_item_modifier_group','menu_item_media'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON menu_item TO hos_app;
