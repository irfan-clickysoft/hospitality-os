-- 0018 Compliance rules: configured by managers, not coded. A rule matches a booking or a check-in (nationality, residency, property, party size, length of stay) and warns, requires a manager's approval, creates a task, requires a document, or blocks.
-- Every match is recorded against the booking, with who approved it and why.

CREATE TABLE compliance_rule (
  tenant_id       uuid NOT NULL REFERENCES tenant(id),
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  name            text NOT NULL CHECK (length(btrim(name)) BETWEEN 3 AND 120),
  description     text,
  status          text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','ACTIVE','DISABLED')),
  stages          text[] NOT NULL CHECK (cardinality(stages) > 0 AND stages <@ ARRAY['BOOKING','CHECK_IN']),
  conditions      jsonb NOT NULL DEFAULT '{}'::jsonb,        -- nationalities, excludeNationalities, residency, propertyIds, minGuests, minNights
  action          text NOT NULL CHECK (action IN ('INFO','WARN','REQUIRE_APPROVAL','REQUIRE_TASK','REQUIRE_DOCUMENT','BLOCK_BOOKING')),
  message         text NOT NULL CHECK (length(btrim(message)) BETWEEN 3 AND 500),
  message_ur      text,
  document_types  text[] NOT NULL DEFAULT '{}',              -- REQUIRE_DOCUMENT: the primary guest must be registered with one of these ID types
  task_title      text,                                      -- REQUIRE_TASK
  reason_code     text,
  effective_from  date,
  effective_to    date,
  created_by      uuid,
  updated_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  version         integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CHECK (effective_to IS NULL OR effective_from IS NULL OR effective_to >= effective_from),
  CHECK (action <> 'REQUIRE_DOCUMENT' OR cardinality(document_types) > 0),
  CHECK (action <> 'REQUIRE_TASK' OR length(btrim(coalesce(task_title,''))) > 0)
);

CREATE TABLE compliance_hit (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  reservation_id  uuid NOT NULL,
  rule_id         uuid NOT NULL,
  rule_name       text NOT NULL,
  stage           text NOT NULL CHECK (stage IN ('BOOKING','CHECK_IN')),
  action          text NOT NULL,
  message         text NOT NULL,
  nationality     text,
  approved_by     uuid,
  approval_reason text,
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reservation_id, rule_id, stage),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES compliance_rule (tenant_id, id),
  CHECK (approved_by IS NULL OR length(btrim(coalesce(approval_reason,''))) >= 3)
);
CREATE INDEX compliance_hit_res_idx ON compliance_hit (tenant_id, reservation_id);
CREATE TRIGGER compliance_hit_append_only BEFORE UPDATE OR DELETE ON compliance_hit FOR EACH ROW EXECUTE FUNCTION prevent_mutation();
CREATE TRIGGER compliance_hit_no_truncate BEFORE TRUNCATE ON compliance_hit FOR EACH STATEMENT EXECUTE FUNCTION prevent_mutation();

CREATE TABLE compliance_task (
  tenant_id       uuid NOT NULL,
  id              uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id     uuid NOT NULL,
  reservation_id  uuid NOT NULL,
  rule_id         uuid NOT NULL,
  title           text NOT NULL,
  due_date        date,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE')),
  completed_by    uuid,
  completed_at    timestamptz,
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reservation_id, rule_id),
  FOREIGN KEY (tenant_id, property_id, reservation_id) REFERENCES reservation (tenant_id, property_id, id),
  FOREIGN KEY (tenant_id, rule_id) REFERENCES compliance_rule (tenant_id, id),
  CHECK ((status = 'DONE') = (completed_by IS NOT NULL))
);
CREATE INDEX compliance_task_open_idx ON compliance_task (tenant_id, property_id, status);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['compliance_rule','compliance_hit','compliance_task'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE ON compliance_rule, compliance_task TO hos_app;
GRANT SELECT, INSERT ON compliance_hit TO hos_app;

INSERT INTO permission (key, description) VALUES
 ('compliance.view',    'See compliance rules, what they matched and the tasks they created'),
 ('compliance.manage',  'Create, edit, activate and disable compliance rules'),
 ('compliance.approve', 'Approve a booking or check-in that a compliance rule holds for approval'),
 ('compliance.task',    'Complete the tasks compliance rules create (e.g. security arrangements)')
ON CONFLICT (key) DO NOTHING;
