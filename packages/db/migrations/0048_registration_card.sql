-- 0048 Registration card: how each companion relates to the main guest, why the guest is visiting, the hotel's own rules and policies, and the guest's on-screen signature (with the rules they accepted).
ALTER TABLE stay_guest ADD COLUMN relationship text CHECK (relationship IS NULL OR length(relationship) <= 40);
ALTER TABLE reservation_room
  ADD COLUMN purpose_of_visit text CHECK (purpose_of_visit IS NULL OR length(purpose_of_visit) <= 80),
  ADD COLUMN reg_signature text CHECK (reg_signature IS NULL OR (reg_signature LIKE 'data:image/png;base64,%' AND length(reg_signature) <= 250000)),
  ADD COLUMN reg_signed_at timestamptz,
  ADD COLUMN reg_signed_name text CHECK (reg_signed_name IS NULL OR length(reg_signed_name) <= 160),
  ADD COLUMN reg_signed_by uuid,
  ADD COLUMN reg_rules text CHECK (reg_rules IS NULL OR length(reg_rules) <= 8000);        -- the rules as they were when signed
ALTER TABLE property ADD COLUMN registration_rules text CHECK (registration_rules IS NULL OR length(registration_rules) <= 8000);
