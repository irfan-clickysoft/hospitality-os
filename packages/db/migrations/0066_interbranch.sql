-- 0066 Finance step 4: inter-branch accounting. A line on a Due From / Due To account says which other branch it is with, so each pair of branches has its own balance.
ALTER TABLE voucher_line ADD COLUMN counterparty_property_id uuid, ADD FOREIGN KEY (tenant_id, counterparty_property_id) REFERENCES property (tenant_id, id),
  ADD CONSTRAINT voucher_line_cp_differs CHECK (counterparty_property_id IS NULL OR property_id IS NOT NULL AND counterparty_property_id <> property_id);
ALTER TABLE gl_entry ADD COLUMN counterparty_property_id uuid;
CREATE INDEX gl_entry_cp_idx ON gl_entry (tenant_id, counterparty_property_id) WHERE counterparty_property_id IS NOT NULL;
