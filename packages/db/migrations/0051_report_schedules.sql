-- 0051 Scheduled reports: a report is generated when a business day closes, frozen as a snapshot, and delivered as an expiring link that needs sign-in and is checked against the viewer's permissions every time it is opened.
INSERT INTO permission (key, description) VALUES ('report.schedule', 'Create and manage scheduled report deliveries') ON CONFLICT (key) DO NOTHING;
ALTER TABLE email_message DROP CONSTRAINT email_message_purpose_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_purpose_check CHECK (purpose IN ('GUEST','COMPANY','QUOTATION','PROPOSAL','REPORT'));

CREATE TABLE report_schedule (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  report_id     text NOT NULL CHECK (length(report_id) BETWEEN 2 AND 60),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  basis         text CHECK (basis IS NULL OR length(basis) <= 30),
  params        jsonb NOT NULL DEFAULT '{}',
  period        text NOT NULL CHECK (period IN ('CLOSED_DAY','LAST_7','LAST_30','MONTH_TO_DATE','PREVIOUS_MONTH','NEXT_7','NEXT_30','NEXT_90')),
  frequency     text NOT NULL CHECK (frequency IN ('DAILY','WEEKLY','MONTHLY')),
  weekday       smallint CHECK (weekday BETWEEN 0 AND 6),
  month_day     smallint CHECK (month_day BETWEEN 0 AND 28),                 -- 0 = the last day of the month (period end)
  alert_kpi     text CHECK (alert_kpi IS NULL OR length(alert_kpi) <= 40),
  alert_op      text CHECK (alert_op IN ('gt','gte','lt','lte','eq')),
  alert_value   numeric,
  recipient_ids uuid[] NOT NULL CHECK (cardinality(recipient_ids) BETWEEN 1 AND 20),
  active        boolean NOT NULL DEFAULT true,
  paused_reason text CHECK (paused_reason IS NULL OR length(paused_reason) <= 200),
  created_by    uuid NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_run_on   date,
  last_status   text,
  version       integer NOT NULL DEFAULT 1,
  PRIMARY KEY (tenant_id, id),
  CHECK ((frequency = 'WEEKLY') = (weekday IS NOT NULL)),
  CHECK ((frequency = 'MONTHLY') = (month_day IS NOT NULL)),
  CHECK ((alert_kpi IS NULL) = (alert_op IS NULL) AND (alert_op IS NULL) = (alert_value IS NULL))
);
CREATE INDEX report_schedule_prop_idx ON report_schedule (tenant_id, property_id, active);

CREATE TABLE report_delivery (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  schedule_id   uuid,
  property_id   uuid NOT NULL,
  report_id     text NOT NULL,
  report_name   text NOT NULL,
  schedule_name text NOT NULL,
  for_date      date NOT NULL,                                               -- the business day that closed
  generated_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  status        text NOT NULL CHECK (status IN ('READY','SKIPPED','FAILED')),
  note          text CHECK (note IS NULL OR length(note) <= 500),
  rows          integer NOT NULL DEFAULT 0,
  snapshot      jsonb,                                                       -- the report exactly as generated; removed once the link has expired
  created_by    uuid NOT NULL,
  PRIMARY KEY (tenant_id, id)
);
CREATE INDEX report_delivery_prop_idx ON report_delivery (tenant_id, property_id, generated_at DESC);
CREATE INDEX report_delivery_sched_idx ON report_delivery (tenant_id, schedule_id, for_date);
CREATE TABLE report_delivery_recipient (
  tenant_id       uuid NOT NULL,
  delivery_id     uuid NOT NULL,
  user_id         uuid NOT NULL,
  email           text NOT NULL,
  mail_status     text NOT NULL DEFAULT 'PENDING' CHECK (mail_status IN ('PENDING','SENT','FAILED','SKIPPED')),
  mail_note       text CHECK (mail_note IS NULL OR length(mail_note) <= 300),
  first_viewed_at timestamptz,
  views           integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, delivery_id, user_id)
);
CREATE INDEX report_delivery_recipient_user_idx ON report_delivery_recipient (tenant_id, user_id, delivery_id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['report_schedule','report_delivery','report_delivery_recipient'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t); EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
