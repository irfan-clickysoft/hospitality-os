-- 0028 Registration cards: children and family members need not carry an ID (one ID often covers a family), and a guest can be found again by their ID number.
-- The ID itself stays sealed. `id_hash` is a keyed hash of the normalised number (the key lives only in the application), so the desk can search "who has this CNIC" without the number being readable.

ALTER TABLE stay_guest
  ALTER COLUMN id_type DROP NOT NULL,
  ALTER COLUMN id_number_sealed DROP NOT NULL,
  ALTER COLUMN id_last4 DROP NOT NULL,
  ADD COLUMN id_hash text,
  ADD CONSTRAINT stay_guest_id_all_or_none CHECK ((id_type IS NULL) = (id_number_sealed IS NULL) AND (id_type IS NULL) = (id_last4 IS NULL)),
  ADD CONSTRAINT stay_guest_hash_shape CHECK (id_hash IS NULL OR id_hash ~ '^[0-9a-f]{64}$');
CREATE INDEX stay_guest_id_hash_idx ON stay_guest (tenant_id, id_hash) WHERE id_hash IS NOT NULL;
