-- What a guest says about their stay, left on their own booking page after check-out. One per booking.
CREATE TABLE guest_feedback (
  tenant_id        uuid NOT NULL,
  id               uuid NOT NULL DEFAULT gen_random_uuid(),
  property_id      uuid NOT NULL,
  reservation_id   uuid NOT NULL,
  overall          smallint NOT NULL CHECK (overall BETWEEN 1 AND 5),
  cleanliness      smallint CHECK (cleanliness BETWEEN 1 AND 5),
  staff            smallint CHECK (staff BETWEEN 1 AND 5),
  comfort          smallint CHECK (comfort BETWEEN 1 AND 5),
  value            smallint CHECK (value BETWEEN 1 AND 5),
  would_recommend  boolean,
  comment          text CHECK (comment IS NULL OR length(comment) <= 1000),
  submitted_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, reservation_id)
);
CREATE INDEX guest_feedback_prop_idx ON guest_feedback (tenant_id, property_id, submitted_at DESC);
ALTER TABLE guest_feedback ENABLE ROW LEVEL SECURITY; ALTER TABLE guest_feedback FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guest_feedback USING (tenant_id = current_tenant_id()) WITH CHECK (tenant_id = current_tenant_id());
GRANT ALL ON guest_feedback TO hos_admin; GRANT SELECT, INSERT ON guest_feedback TO hos_app;
