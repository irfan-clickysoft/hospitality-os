-- 0031 Everything a guest or an accountant needs to pay into or reconcile a bank account: branch, branch code, address, IBAN, account number, SWIFT, and the account's QR code (a picture).
ALTER TABLE payment_account
  ADD COLUMN branch         text CHECK (branch IS NULL OR length(branch) <= 120),
  ADD COLUMN branch_code    text CHECK (branch_code IS NULL OR length(branch_code) <= 20),
  ADD COLUMN branch_address text CHECK (branch_address IS NULL OR length(branch_address) <= 300),
  ADD COLUMN iban           text CHECK (iban IS NULL OR iban ~ '^[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}$'),
  ADD COLUMN account_number text CHECK (account_number IS NULL OR account_number ~ '^[0-9A-Za-z -]{4,34}$'),
  ADD COLUMN swift_code     text CHECK (swift_code IS NULL OR swift_code ~ '^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$'),
  ADD COLUMN qr_file        text CHECK (qr_file IS NULL OR qr_file ~ '^[0-9a-f]{32}\.(jpg|png|webp)$');
