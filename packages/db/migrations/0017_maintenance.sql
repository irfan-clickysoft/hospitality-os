-- 0017 Maintenance work orders: a fault found by anyone becomes a job with an owner, a status, a cost and — when the room cannot be sold — an out-of-order block that is released when the job is checked.

CREATE TABLE work_order (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  number        text NOT NULL,
  room_id       uuid,
  area          text,
  category      text NOT NULL CHECK (category IN ('PLUMBING','ELECTRICAL','AC','FURNITURE','APPLIANCE','CLEANLINESS','SAFETY','OTHER')),
  title         text NOT NULL CHECK (length(btrim(title)) BETWEEN 3 AND 160),
  description   text,
  priority      smallint NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 4),     -- 1 urgent … 4 low
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ASSIGNED','IN_PROGRESS','WAITING','DONE','VERIFIED','CANCELLED')),
  assigned_to   uuid,
  issue_id      uuid,                                                          -- the housekeeping report this came from
  block_id      uuid,                                                          -- the out-of-order block taken for it
  due_date      date,
  cost_minor    bigint NOT NULL DEFAULT 0 CHECK (cost_minor >= 0),
  vendor        text,
  reported_by   uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  done_at       timestamptz,
  done_by       uuid,
  done_note     text,
  verified_at   timestamptz,
  verified_by   uuid,
  version       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, number),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id),
  FOREIGN KEY (tenant_id, room_id) REFERENCES room (tenant_id, id),
  FOREIGN KEY (tenant_id, issue_id) REFERENCES room_issue (tenant_id, id),
  FOREIGN KEY (tenant_id, block_id) REFERENCES room_block (tenant_id, id),
  CHECK (verified_by IS NULL OR verified_by <> done_by)                          -- someone else checks the work
);
CREATE INDEX work_order_prop_idx ON work_order (tenant_id, property_id, status);
CREATE INDEX work_order_assignee_idx ON work_order (tenant_id, assigned_to) WHERE status IN ('ASSIGNED','IN_PROGRESS','WAITING');
CREATE INDEX work_order_room_idx ON work_order (tenant_id, room_id) WHERE room_id IS NOT NULL;
CREATE UNIQUE INDEX work_order_one_per_issue ON work_order (tenant_id, issue_id) WHERE issue_id IS NOT NULL AND status <> 'CANCELLED';

CREATE TABLE work_order_event (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  work_order_id uuid NOT NULL,
  action        text NOT NULL,
  from_status   text,
  to_status     text,
  note          text,
  amount_minor  bigint,
  actor_id      uuid NOT NULL,
  at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, work_order_id) REFERENCES work_order (tenant_id, id)
);
CREATE INDEX work_order_event_idx ON work_order_event (tenant_id, work_order_id, at);
CREATE TRIGGER work_order_event_append_only BEFORE UPDATE OR DELETE ON work_order_event FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER work_order_event_no_truncate BEFORE TRUNCATE ON work_order_event FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['work_order','work_order_event'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON work_order TO hos_app;
GRANT SELECT, INSERT ON work_order_event TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('maintenance.view',   'See maintenance work orders'),
 ('maintenance.manage', 'Create, assign, check and cancel maintenance work orders'),
 ('maintenance.work',   'Be assigned work orders: start, wait, finish')
ON CONFLICT (key) DO NOTHING;
