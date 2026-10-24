-- 0046 Quotation layout the way Sunset BnB writes them: the customer's address and customer number, the rooms by number, a balance date (e.g. 30 days before check-in), and the wording
-- around the figures (greeting, closing, contact details, terms) kept per property so each hotel can write its own.
ALTER TABLE quotation ADD COLUMN address text CHECK (address IS NULL OR length(address) <= 300), ADD COLUMN customer_ref text CHECK (customer_ref IS NULL OR length(customer_ref) <= 60),
  ADD COLUMN balance_due_days integer CHECK (balance_due_days IS NULL OR balance_due_days BETWEEN 0 AND 365);
ALTER TABLE quotation_line ADD COLUMN room_numbers text CHECK (room_numbers IS NULL OR length(room_numbers) <= 200);
ALTER TABLE property ADD COLUMN quote_settings jsonb;
