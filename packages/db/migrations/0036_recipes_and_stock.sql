-- 0036 Recipes and kitchen stock. A recipe (a dish, or a sub-recipe such as a gravy or a marinade) has versions: a draft is edited, an approved version is the one the kitchen cooks from
-- and the one costed and deducted from stock. A version holds the yield, ingredients (stock items or other recipes), steps, equipment, cooking, plating, food safety and a how-to-prepare video.
-- Stock items are counted in a base unit (g, ml or pieces); every change to the count is a movement, so the count can always be explained.

INSERT INTO permission (key, description) VALUES
 ('recipe.approve', 'Approve a recipe version so the kitchen cooks from it and it is costed')
ON CONFLICT (key) DO NOTHING;

CREATE TABLE stock_item (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 80),
  unit            text NOT NULL CHECK (unit IN ('g','ml','pcs')),
  unit_cost_minor numeric(18,4) NOT NULL DEFAULT 0 CHECK (unit_cost_minor >= 0),     -- what one g / ml / piece costs, in the smallest currency unit
  on_hand         numeric(18,3) NOT NULL DEFAULT 0,                                  -- may go below zero when food is cooked before the delivery is entered; that is shown, not hidden
  reorder_level   numeric(18,3) CHECK (reorder_level IS NULL OR reorder_level >= 0),
  active          boolean NOT NULL DEFAULT true,
  version         integer NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE UNIQUE INDEX stock_item_name_uq ON stock_item (tenant_id, property_id, lower(btrim(name))) WHERE active;

CREATE TABLE stock_movement (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  item_id         uuid NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('RECEIVE','ADJUST','WASTE','SALE')),
  qty             numeric(18,3) NOT NULL,                                            -- signed: how much the count changed
  unit_cost_minor numeric(18,4),
  note            text,
  order_line_id   uuid,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, item_id) REFERENCES stock_item (tenant_id, id)
);
CREATE UNIQUE INDEX stock_movement_sale_uq ON stock_movement (tenant_id, order_line_id, item_id) WHERE kind = 'SALE';        -- a delivered line is deducted once
CREATE INDEX stock_movement_item_idx ON stock_movement (tenant_id, item_id, created_at DESC);

CREATE TABLE recipe (
  tenant_id          uuid NOT NULL,
  id                 uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id        uuid NOT NULL,
  name               text NOT NULL CHECK (length(btrim(name)) BETWEEN 2 AND 120),
  kind               text NOT NULL CHECK (kind IN ('DISH','SUB_RECIPE')),
  menu_item_id       uuid,                                                           -- the dish on the menu this recipe makes
  current_version_id uuid,
  active             boolean NOT NULL DEFAULT true,
  created_by         uuid,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, menu_item_id) REFERENCES menu_item (tenant_id, id),
  CHECK (kind = 'DISH' OR menu_item_id IS NULL)
);
CREATE UNIQUE INDEX recipe_name_uq ON recipe (tenant_id, property_id, lower(btrim(name))) WHERE active;
CREATE UNIQUE INDEX recipe_menu_item_uq ON recipe (tenant_id, menu_item_id) WHERE menu_item_id IS NOT NULL AND active;

CREATE TABLE recipe_version (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  recipe_id     uuid NOT NULL,
  version_no    integer NOT NULL,
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','RETIRED')),
  yield_qty     numeric(18,3) NOT NULL DEFAULT 1 CHECK (yield_qty > 0),             -- portions for a dish; g, ml or pieces for a sub-recipe
  yield_unit    text NOT NULL DEFAULT 'portion' CHECK (yield_unit IN ('portion','g','ml','pcs')),
  prep_minutes  integer CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 0 AND 1440),
  cook_minutes  integer CHECK (cook_minutes IS NULL OR cook_minutes BETWEEN 0 AND 1440),
  steps         text[] NOT NULL DEFAULT '{}',
  equipment     text[] NOT NULL DEFAULT '{}',
  cooking_method text,
  temperature   text,
  plating       text,
  food_safety   text,
  change_note   text,
  video_file    text,
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  approved_by   uuid,
  approved_at   timestamptz,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, recipe_id) REFERENCES recipe (tenant_id, id),
  UNIQUE (tenant_id, recipe_id, version_no)
);
CREATE UNIQUE INDEX recipe_version_one_approved ON recipe_version (tenant_id, recipe_id) WHERE status = 'APPROVED';
CREATE UNIQUE INDEX recipe_version_one_draft ON recipe_version (tenant_id, recipe_id) WHERE status = 'DRAFT';
ALTER TABLE recipe ADD CONSTRAINT recipe_current_fk FOREIGN KEY (tenant_id, current_version_id) REFERENCES recipe_version (tenant_id, id);

CREATE TABLE recipe_line (
  tenant_id      uuid NOT NULL,
  id             uuid NOT NULL DEFAULT gen_random_uuid(),
  version_id     uuid NOT NULL,
  seq            integer NOT NULL,
  stock_item_id  uuid,
  sub_recipe_id  uuid,
  qty            numeric(18,3) NOT NULL CHECK (qty > 0),                             -- in the stock item's unit, or the sub-recipe's yield unit
  waste_pct      numeric(5,2) NOT NULL DEFAULT 0 CHECK (waste_pct >= 0 AND waste_pct < 100),
  note           text,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, version_id) REFERENCES recipe_version (tenant_id, id),
  FOREIGN KEY (tenant_id, stock_item_id) REFERENCES stock_item (tenant_id, id),
  FOREIGN KEY (tenant_id, sub_recipe_id) REFERENCES recipe (tenant_id, id),
  CHECK ((stock_item_id IS NULL) <> (sub_recipe_id IS NULL))
);
CREATE INDEX recipe_line_version_idx ON recipe_line (tenant_id, version_id, seq);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['stock_item','stock_movement','recipe','recipe_version','recipe_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON stock_item, recipe, recipe_version TO hos_app;
GRANT SELECT, INSERT ON stock_movement TO hos_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recipe_line TO hos_app;
