-- 0016 Bulk data import (guests, companies). One permission; the imports themselves are audited and idempotent.
INSERT INTO permission (key, description) VALUES
 ('data.import', 'Bulk-import guests and corporate accounts from a spreadsheet')
ON CONFLICT (key) DO NOTHING;
