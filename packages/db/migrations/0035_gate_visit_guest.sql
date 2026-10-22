-- 0035 A gate visitor who stays overnight becomes a registered guest: the visit remembers which guest it became.
ALTER TABLE gate_visit
  ADD COLUMN guest_id uuid,
  ADD CONSTRAINT gate_visit_guest_fk FOREIGN KEY (tenant_id, guest_id) REFERENCES guest (tenant_id, id);
