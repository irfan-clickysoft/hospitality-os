-- 0003 Outbox retry bookkeeping + property.view permission.
ALTER TABLE outbox_event
  ADD COLUMN attempts         integer     NOT NULL DEFAULT 0,
  ADD COLUMN last_error       text,
  ADD COLUMN dead_lettered_at timestamptz,
  ADD COLUMN seq              bigint      GENERATED ALWAYS AS IDENTITY;  -- total order for relay (created_at is per-transaction, not per-row)
DROP INDEX outbox_unpublished_idx;
CREATE INDEX outbox_pending_idx ON outbox_event (seq) WHERE published_at IS NULL AND dead_lettered_at IS NULL;

INSERT INTO permission (key, description) VALUES ('property.view', 'View property details, rooms and configuration')
ON CONFLICT (key) DO NOTHING;
