-- 0033 The guest registration matrix: the kind of guest each person on the card is, which documents were seen (or why not), the foreign-guest record, and who the guardian of a child is.
ALTER TABLE stay_guest
  ADD COLUMN guest_type      text CHECK (guest_type IS NULL OR guest_type IN ('PAKISTANI_ADULT','OVERSEAS_PAKISTANI','POC_HOLDER','FOREIGN_ADULT','PAKISTANI_MINOR','FOREIGN_MINOR')),
  ADD COLUMN documents       jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN foreign_details jsonb,
  ADD COLUMN guardian_id     uuid,
  ADD CONSTRAINT stay_guest_guardian_fk FOREIGN KEY (tenant_id, guardian_id) REFERENCES stay_guest (tenant_id, id),
  ADD CONSTRAINT stay_guest_not_own_guardian CHECK (guardian_id IS NULL OR guardian_id <> id);

-- Whether an incomplete card stops check-in (strict) or only shows what is missing (the default), and whether a NICOP alone is accepted for overseas Pakistanis.
ALTER TABLE property
  ADD COLUMN registration_strict boolean NOT NULL DEFAULT false,
  ADD COLUMN nicop_alone_ok      boolean NOT NULL DEFAULT false;
