-- 0047 Corporate rate proposals: the letter a company gets with the hotel's rates by room category and number of guests, what is included, the terms, how to book and bill, and room photos.
-- Sent as a private link like a quotation; no acceptance step (the company books with the reference code).
CREATE TABLE rate_proposal (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id   uuid NOT NULL,
  number        text NOT NULL,
  reference     text CHECK (reference IS NULL OR length(reference) <= 60),               -- the code the company quotes when booking
  status        text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ARCHIVED')),
  company_id    uuid,
  company_name  text NOT NULL CHECK (length(company_name) BETWEEN 2 AND 160),
  attn_name     text CHECK (attn_name IS NULL OR length(attn_name) <= 160),
  attn_title    text CHECK (attn_title IS NULL OR length(attn_title) <= 160),
  issued_on     date NOT NULL,
  valid_from    date NOT NULL,
  valid_to      date NOT NULL CHECK (valid_to >= valid_from),
  title         text CHECK (title IS NULL OR length(title) <= 200),
  intro         text CHECK (intro IS NULL OR length(intro) <= 3000),
  notes         jsonb NOT NULL DEFAULT '[]',                                              -- lists of short lines: notes under the table, facilities, terms, billing steps
  facilities    jsonb NOT NULL DEFAULT '[]',
  terms         jsonb NOT NULL DEFAULT '[]',
  billing       jsonb NOT NULL DEFAULT '{}',                                              -- { contactName, phone, email, steps: [...] }
  signatory     text CHECK (signatory IS NULL OR length(signatory) <= 300),
  with_photos   boolean NOT NULL DEFAULT true,
  currency      text NOT NULL DEFAULT 'PKR',
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  version       integer NOT NULL DEFAULT 1,
  sent_at       timestamptz,
  views         integer NOT NULL DEFAULT 0,
  viewed_at     timestamptz,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, number),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE INDEX rate_proposal_list_idx ON rate_proposal (tenant_id, property_id, status, created_at DESC);

CREATE TABLE rate_proposal_row (
  tenant_id    uuid NOT NULL,
  id           uuid NOT NULL DEFAULT gen_random_uuid(),
  proposal_id  uuid NOT NULL,
  sort_order   integer NOT NULL,
  label        text NOT NULL CHECK (length(label) BETWEEN 2 AND 160),
  room_type_id uuid,                                                                      -- gives the row its photos
  p1           bigint CHECK (p1 IS NULL OR p1 >= 0),
  p2           bigint CHECK (p2 IS NULL OR p2 >= 0),
  p3           bigint CHECK (p3 IS NULL OR p3 >= 0),
  p4           bigint CHECK (p4 IS NULL OR p4 >= 0),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, proposal_id) REFERENCES rate_proposal (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX rate_proposal_row_idx ON rate_proposal_row (tenant_id, proposal_id, sort_order);

ALTER TABLE document_link DROP CONSTRAINT document_link_kind_check;
ALTER TABLE document_link ADD CONSTRAINT document_link_kind_check CHECK (kind IN ('PAYMENT','STATEMENT','ORDER','INVOICE','COMPANY_STATEMENT','QUOTATION','RATE_PROPOSAL'));
ALTER TABLE email_message DROP CONSTRAINT email_message_purpose_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_purpose_check CHECK (purpose IN ('GUEST','COMPANY','QUOTATION','PROPOSAL'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['rate_proposal','rate_proposal_row'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;
