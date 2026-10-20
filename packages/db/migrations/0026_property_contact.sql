-- 0026 Where the property is, for the confirmation message a guest receives: the city, and a Google Maps link to the door.
ALTER TABLE property
  ADD COLUMN city     text CHECK (city IS NULL OR length(btrim(city)) BETWEEN 2 AND 80),
  ADD COLUMN maps_url text CHECK (maps_url IS NULL OR (length(maps_url) <= 500 AND maps_url ~ '^https://'));
