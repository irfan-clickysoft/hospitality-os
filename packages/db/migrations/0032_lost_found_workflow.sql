-- 0032 Lost & found as a workflow: what was found, when and where, a photo, who it may belong to, where it is kept, contact with the owner, and a recorded hand-over (or disposal).

ALTER TABLE lost_found DROP CONSTRAINT lost_found_status_check;
ALTER TABLE lost_found
  ADD CONSTRAINT lost_found_status_check CHECK (status IN ('FOUND','OWNER_CONTACTED','RETURNED','DISPOSED')),
  ADD COLUMN ref              text,
  ADD COLUMN category         text NOT NULL DEFAULT 'OTHER' CHECK (category IN ('DOCUMENT','ELECTRONICS','JEWELLERY','CLOTHING','BAG','KEYS','MONEY','MEDICINE','OTHER')),
  ADD COLUMN high_value       boolean NOT NULL DEFAULT false,
  ADD COLUMN storage_location text CHECK (storage_location IS NULL OR length(storage_location) <= 120),
  ADD COLUMN guest_id         uuid,
  ADD COLUMN reservation_id   uuid,
  ADD COLUMN dispose_after    date,
  ADD COLUMN receiver_name    text CHECK (receiver_name IS NULL OR length(btrim(receiver_name)) BETWEEN 2 AND 120),
  ADD COLUMN receiver_id_note text CHECK (receiver_id_note IS NULL OR length(receiver_id_note) <= 80),
  ADD COLUMN handover_method  text CHECK (handover_method IS NULL OR handover_method IN ('HAND_OVER','REPRESENTATIVE','COURIER')),
  ADD COLUMN courier_ref      text CHECK (courier_ref IS NULL OR length(courier_ref) <= 80),
  ADD COLUMN verified_note    text CHECK (verified_note IS NULL OR length(verified_note) <= 300),
  ADD COLUMN version          integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT lost_found_guest_fk FOREIGN KEY (tenant_id, guest_id) REFERENCES guest (tenant_id, id),
  ADD CONSTRAINT lost_found_reservation_fk FOREIGN KEY (tenant_id, reservation_id) REFERENCES reservation (tenant_id, id);
CREATE UNIQUE INDEX lost_found_ref_idx ON lost_found (tenant_id, property_id, ref) WHERE ref IS NOT NULL;
CREATE INDEX lost_found_guest_idx ON lost_found (tenant_id, guest_id) WHERE guest_id IS NOT NULL;
GRANT UPDATE ON lost_found TO hos_app;

CREATE TABLE lost_found_event (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  lost_found_id uuid NOT NULL,
  action        text NOT NULL,
  note          text,
  actor_id      uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, lost_found_id) REFERENCES lost_found (tenant_id, id)
);
CREATE INDEX lost_found_event_idx ON lost_found_event (tenant_id, lost_found_id, at);
CREATE TRIGGER lost_found_event_append_only BEFORE UPDATE OR DELETE ON lost_found_event FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER lost_found_event_no_truncate BEFORE TRUNCATE ON lost_found_event FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

CREATE TABLE lost_found_media (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  lost_found_id uuid NOT NULL,
  phase         text NOT NULL DEFAULT 'FOUND' CHECK (phase IN ('FOUND','HANDOVER')),
  file_name     text NOT NULL CHECK (file_name ~ '^[0-9a-f]{32}\.(jpg|png|webp)$'),
  uploaded_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, lost_found_id) REFERENCES lost_found (tenant_id, id)
);
CREATE INDEX lost_found_media_idx ON lost_found_media (tenant_id, lost_found_id);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['lost_found_event','lost_found_media'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT ON lost_found_event TO hos_app;
GRANT SELECT, INSERT, DELETE ON lost_found_media TO hos_app;
