-- 0045 Quotations. A priced offer for one or more rooms (a few nights or a month, up to the whole guest house) with discounts, special requests, amenities and an advance request.
-- It is sent to the customer as a private link, the customer accepts or declines on that page (which tells the desk), and an accepted quotation becomes a booking.
CREATE TABLE quotation (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  number           text NOT NULL,
  status           text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','SENT','ACCEPTED','DECLINED','CANCELLED','CONVERTED')),
  company_id       uuid,
  guest_id         uuid,
  customer_name    text NOT NULL CHECK (length(customer_name) BETWEEN 2 AND 120),
  contact_name     text CHECK (contact_name IS NULL OR length(contact_name) <= 120),
  phone            text CHECK (phone IS NULL OR length(phone) <= 40),
  email            text CHECK (email IS NULL OR length(email) <= 254),
  residency        text NOT NULL DEFAULT 'RESIDENT' CHECK (residency IN ('RESIDENT','NON_RESIDENT')),
  title            text CHECK (title IS NULL OR length(title) <= 160),
  valid_until      date NOT NULL,
  discount_kind    text NOT NULL DEFAULT 'NONE' CHECK (discount_kind IN ('NONE','PCT','AMOUNT')),
  discount_value   bigint NOT NULL DEFAULT 0 CHECK (discount_value >= 0),               -- percent in hundredths (1250 = 12.5%), or an amount in minor units
  discount_reason  text CHECK (discount_reason IS NULL OR length(discount_reason) <= 200),
  deposit_kind     text NOT NULL DEFAULT 'NONE' CHECK (deposit_kind IN ('NONE','PCT','AMOUNT')),
  deposit_value    bigint NOT NULL DEFAULT 0 CHECK (deposit_value >= 0),               -- percent in hundredths, or an amount in minor units
  special_requests text CHECK (special_requests IS NULL OR length(special_requests) <= 2000),
  amenities        text[] NOT NULL DEFAULT '{}',
  terms            text CHECK (terms IS NULL OR length(terms) <= 4000),
  notes_internal   text CHECK (notes_internal IS NULL OR length(notes_internal) <= 2000),
  pricing          jsonb,                                                                -- the figures as last worked out (what the customer sees)
  created_by       uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  version          integer NOT NULL DEFAULT 1,
  sent_at          timestamptz,
  sent_by          uuid,
  viewed_at        timestamptz,
  views            integer NOT NULL DEFAULT 0,
  responded_at     timestamptz,
  responded_name   text CHECK (responded_name IS NULL OR length(responded_name) <= 120),
  responded_note   text CHECK (responded_note IS NULL OR length(responded_note) <= 1000),
  desk_seen_at     timestamptz,                                                          -- the desk has seen the customer's answer
  converted_at     timestamptz,
  reservation_ids  uuid[] NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, property_id, number),
  FOREIGN KEY (tenant_id, property_id) REFERENCES property (tenant_id, id)
);
CREATE INDEX quotation_list_idx ON quotation (tenant_id, property_id, status, created_at DESC);

CREATE TABLE quotation_line (
  tenant_id     uuid NOT NULL,
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  quotation_id  uuid NOT NULL,
  line_no       integer NOT NULL,
  room_type_id  uuid NOT NULL,
  rate_plan_id  uuid,                                                                    -- the plan used to price it (the cheapest eligible one when empty)
  rooms         integer NOT NULL DEFAULT 1 CHECK (rooms BETWEEN 1 AND 60),
  arrival       date NOT NULL,
  departure     date NOT NULL CHECK (departure > arrival),
  adults        integer NOT NULL DEFAULT 2 CHECK (adults BETWEEN 1 AND 20),
  children      integer NOT NULL DEFAULT 0 CHECK (children BETWEEN 0 AND 20),
  extra_beds    integer NOT NULL DEFAULT 0 CHECK (extra_beds BETWEEN 0 AND 5),
  discount_kind text NOT NULL DEFAULT 'NONE' CHECK (discount_kind IN ('NONE','PCT','AMOUNT')),
  discount_value bigint NOT NULL DEFAULT 0 CHECK (discount_value >= 0),                 -- amount: for the whole line (all its rooms)
  note          text CHECK (note IS NULL OR length(note) <= 300),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, quotation_id) REFERENCES quotation (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX quotation_line_q_idx ON quotation_line (tenant_id, quotation_id, line_no);

ALTER TABLE document_link DROP CONSTRAINT document_link_kind_check;
ALTER TABLE document_link ADD CONSTRAINT document_link_kind_check CHECK (kind IN ('PAYMENT','STATEMENT','ORDER','INVOICE','COMPANY_STATEMENT','QUOTATION'));

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['quotation','quotation_line'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id())', t);
    EXECUTE format('GRANT ALL ON %I TO hos_admin', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO hos_app', t);
  END LOOP;
END $$;

ALTER TABLE email_message DROP CONSTRAINT email_message_purpose_check;
ALTER TABLE email_message ADD CONSTRAINT email_message_purpose_check CHECK (purpose IN ('GUEST','COMPANY','QUOTATION'));
