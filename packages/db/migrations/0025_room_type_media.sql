-- 0025 Pictures and videos for a room type, shown to staff and sent to guests in the booking confirmation. The file itself lives on the media volume under an unguessable name;
-- this table says whose it is, what it is and in which order to show it.

CREATE TABLE room_type_media (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id  uuid NOT NULL,
  room_type_id uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('IMAGE','VIDEO')),
  file_name    text NOT NULL CHECK (file_name ~ '^[0-9a-f]{32}\.(jpg|png|webp|mp4|webm)$'),
  content_type text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes > 0),
  caption      text CHECK (caption IS NULL OR length(caption) <= 160),
  sort_order   int NOT NULL DEFAULT 0,
  uploaded_by  uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (file_name),
  FOREIGN KEY (tenant_id, property_id, room_type_id) REFERENCES room_type (tenant_id, property_id, id)
);
CREATE INDEX room_type_media_idx ON room_type_media (tenant_id, room_type_id, sort_order);

ALTER TABLE room_type_media ENABLE ROW LEVEL SECURITY;
ALTER TABLE room_type_media FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON room_type_media USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON room_type_media TO hos_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON room_type_media TO hos_app;
