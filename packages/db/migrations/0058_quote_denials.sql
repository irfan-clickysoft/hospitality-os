-- A search for dates where a room type was sold out: demand the property could not take. One line per person, dates, room type and day, so repeated searching does not count twice.
CREATE TABLE quote_denial (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  user_id       uuid,
  searched_on   date NOT NULL,
  arrival       date NOT NULL,
  departure     date NOT NULL,
  room_type_id  uuid NOT NULL,
  adults        integer NOT NULL DEFAULT 1,
  children      integer NOT NULL DEFAULT 0,
  channel       text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id)
);
CREATE UNIQUE INDEX quote_denial_once ON quote_denial (tenant_id, property_id, user_id, searched_on, arrival, departure, room_type_id) NULLS NOT DISTINCT;
CREATE INDEX quote_denial_prop_idx ON quote_denial (tenant_id, property_id, searched_on DESC);
ALTER TABLE quote_denial ENABLE ROW LEVEL SECURITY; ALTER TABLE quote_denial FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON quote_denial USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON quote_denial TO hos_admin; GRANT SELECT, INSERT ON quote_denial TO hos_app;
